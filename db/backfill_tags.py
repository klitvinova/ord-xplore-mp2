#!/usr/bin/env python3
"""
Backfill the `tags` / `document_tags` tables from the raw TEI corpus.

Why this exists
---------------
`data/pipeline/visualisation_prep/extract_all_tags.py` produced tag_presence.json
keyed by *basename*, over a 259k-file corpus. The SQL database holds 127,606
documents whose ids come from the row order of
`data/pipeline/visualisation_prep/dashboard_data.json` (see
`json_to_postgres.py`, which does `doc_id_to_pk[doc_raw_id] = idx` with idx
starting at 1). Basenames are not unique across editions, so the old file
cannot be joined to the database. This script rebuilds the mapping from the
authoritative source instead: each dashboard_data.json record carries an
`id` of the form "<edition>/<path>/<file>.xml", which is the path of the
document relative to the raw corpus root.

Usage
-----
    pip install psycopg2-binary
    python3 db/backfill_tags.py \
        --dashboard-json "../data/pipeline/visualisation_prep/dashboard_data.json" \
        --corpus-root    "../raw_documents" \
        --dsn            "postgresql://karina@localhost:5432/ord_xplore"

Run `db/001_add_tags.sql` first. The script is idempotent: it truncates
document_tags before loading.
"""

import argparse
import io
import json
import os
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

try:
    import psycopg2
except ImportError:
    sys.exit("psycopg2 is required:  pip install psycopg2-binary")


# Tags that appear in essentially every TEI file carry no filtering signal and
# would bloat the join table by millions of rows. They are still recorded --
# the dashboard sorts by frequency, so the user sees they are useless -- but
# this is the knob to turn if the load is too slow.
SKIP_TAGS = set()


def tags_in_file(path):
    """Return Counter of namespace-stripped element names, or None on parse error."""
    counts = Counter()
    try:
        for _event, elem in ET.iterparse(path, events=("end",)):
            tag = elem.tag
            if not isinstance(tag, str):
                continue  # comments / PIs surface as callables
            if "}" in tag:
                tag = tag.split("}", 1)[1]
            if tag in SKIP_TAGS:
                continue
            counts[tag] += 1
            elem.clear()  # keep memory flat on large files
    except (ET.ParseError, OSError):
        return None
    return counts


def _worker(job):
    pk, path = job
    return pk, tags_in_file(path)


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument(
        "--dashboard-json",
        default=os.path.join(here, "..", "..", "data", "pipeline",
                             "visualisation_prep", "dashboard_data.json"),
    )
    ap.add_argument(
        "--corpus-root",
        default=os.path.join(here, "..", "..", "raw_documents"),
    )
    ap.add_argument(
        "--dsn",
        default=os.environ.get("DATABASE_URL",
                               "postgresql://karina@localhost:5432/ord_xplore"),
    )
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--batch", type=int, default=20000,
                    help="documents per COPY flush")
    ap.add_argument("--max-id", type=int, default=0,
                    help="only backfill documents with id <= this (0 = the whole "
                         "dashboard_data.json range). Use when the database holds "
                         "a different vintage of the dump.")
    args = ap.parse_args()

    print(f"Loading {args.dashboard_json} ...")
    with open(args.dashboard_json, encoding="utf-8") as fh:
        docs = json.load(fh)
    print(f"  {len(docs):,} records")
    if args.max_id:
        docs = docs[:args.max_id]
        print(f"  restricted to the first {len(docs):,} by --max-id")

    conn = psycopg2.connect(args.dsn)
    conn.autocommit = False
    cur = conn.cursor()

    # --- Guard: the index->pk assumption must actually hold -------------------
    n_docs = len(docs)

    cur.execute("SELECT COUNT(*) FROM documents;")
    db_count = cur.fetchone()[0]

    # Documents ingested through /api/upload sit above the dump's id range and
    # are not in dashboard_data.json -- there is no raw file for them here, and
    # upload.js already recorded their tags. They are fine to leave alone; what
    # is NOT fine is the dump's own id range having shifted underneath us.
    cur.execute("SELECT COUNT(*) FROM documents WHERE id <= %s;", (n_docs,))
    in_range = cur.fetchone()[0]
    extras = db_count - in_range

    if in_range != n_docs:
        sys.exit(
            f"ABORT: dashboard_data.json has {n_docs:,} records but the documents "
            f"table has {in_range:,} rows with id <= {n_docs:,} (total {db_count:,}). "
            f"The positional id mapping this script relies on does not hold. "
            f"Reload the database from data/ord_xplore_mp_geocoded.sql, or pass "
            f"--max-id to restrict the backfill."
        )

    if extras:
        print(f"  note: {extras:,} document(s) with id > {n_docs:,} are not in the "
              f"dump (uploaded later); their tags are left untouched")

    # Spot-check titles at a few positions rather than trusting the count alone.
    probes = [1, len(docs) // 2, len(docs)]
    cur.execute("SELECT id, name FROM documents WHERE id = ANY(%s);", (probes,))
    by_id = dict(cur.fetchall())
    for pk in probes:
        expected = str(docs[pk - 1].get("title", ""))
        actual = by_id.get(pk)
        if actual is not None and expected and actual != expected:
            sys.exit(
                f"ABORT: id {pk} is '{actual}' in the database but '{expected}' at "
                f"position {pk - 1} of dashboard_data.json. Mapping is unsafe."
            )
    print("  id mapping verified against documents table")

    # --- Collect work --------------------------------------------------------
    jobs, missing = [], 0
    for idx, d in enumerate(docs, start=1):
        rel = d.get("id")
        if not rel:
            missing += 1
            continue
        path = os.path.join(args.corpus_root, rel)
        if not os.path.exists(path):
            missing += 1
            continue
        jobs.append((idx, path))
    print(f"  {len(jobs):,} files to parse, {missing:,} missing from corpus")

    if not jobs:
        sys.exit("ABORT: no source files found. Check --corpus-root.")

    # --- Parse ---------------------------------------------------------------
    tag_to_id = {}
    pending = []          # (document_id, tag_id, occurrences)
    parsed = failed = 0
    rows_written = 0

    def flush():
        nonlocal pending, rows_written
        if not pending:
            return
        buf = io.StringIO()
        for doc_id, tag_id, occ in pending:
            buf.write(f"{doc_id}\t{tag_id}\t{occ}\n")
        buf.seek(0)
        cur.copy_from(buf, "document_tags",
                      columns=("document_id", "tag_id", "occurrences"))
        rows_written += len(pending)
        pending = []

    # Clear only the id range we are about to rewrite. TRUNCATE would also wipe
    # tags that upload.js recorded for documents ingested after the dump.
    print(f"Clearing document_tags for ids <= {n_docs:,} ...")
    cur.execute("DELETE FROM document_tags WHERE document_id <= %s;", (n_docs,))

    # Preload any tags already registered so ids stay stable across reruns.
    cur.execute("SELECT name, id FROM tags;")
    tag_to_id.update(dict(cur.fetchall()))

    print(f"Parsing with {args.workers} workers ...")
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for pk, counts in pool.map(_worker, jobs, chunksize=200):
            if counts is None:
                failed += 1
                continue
            parsed += 1
            for name, occ in counts.items():
                name = name[:255]
                tag_id = tag_to_id.get(name)
                if tag_id is None:
                    cur.execute(
                        "INSERT INTO tags (name) VALUES (%s) "
                        "ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name "
                        "RETURNING id;",
                        (name,),
                    )
                    tag_id = cur.fetchone()[0]
                    tag_to_id[name] = tag_id
                pending.append((pk, tag_id, occ))

            if len(pending) >= args.batch:
                flush()
                print(f"  {parsed:,}/{len(jobs):,} documents, "
                      f"{rows_written:,} rows", end="\r")

    flush()
    print()

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM tags;")
    n_tags = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM document_tags;")
    n_rows = cur.fetchone()[0]
    cur.execute("ANALYZE document_tags;")
    conn.commit()
    cur.close()
    conn.close()

    print(f"Done. {parsed:,} documents parsed, {failed:,} unparseable.")
    print(f"      {n_tags:,} distinct tags, {n_rows:,} document_tags rows.")


if __name__ == "__main__":
    main()
