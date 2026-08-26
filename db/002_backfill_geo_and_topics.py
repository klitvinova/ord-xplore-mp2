#!/usr/bin/env python3
"""
Repair two things the SQL dump got wrong.

1. geolocations.geometry
   `ord_xplore_mp_generated.sql` (2026-07-29, the newest dump) ships 21,792
   geolocation rows with geometry = NULL on every single one. The older
   `ord_xplore_mp_migrated.sql` / `ord_xplore_mp_clean.sql` (2026-07-21) have
   all 27,518 rows geocoded. With the newest dump loaded, /api/dashboard's
   ST_Y/ST_X return NULL, so the map and the city facet are completely empty.
   This script re-applies the coordinates from the authoritative gazetteer,
   data/pipeline/visualisation_prep/geo_data/geocoding_map.json, so it no
   longer matters which dump you loaded.

2. topics.name / topics.words
   The dump has placeholder values -- every topic is literally named
   "Topic T<n>" with words {topic,keywords}. The real values are in
   app/topics_hierarchy.json, which the frontend loads separately (which is
   why the UI looks fine while the database does not). Uploading a document
   needs the real keyword lists to assign topics, so they have to be in SQL.

Usage:
    pip install psycopg2-binary
    python3 db/002_backfill_geo_and_topics.py --dsn postgresql://karina@localhost:5432/ord_xplore

Idempotent. Safe to re-run.
"""

import argparse
import json
import os
import sys

try:
    import psycopg2
    from psycopg2.extras import execute_batch
except ImportError:
    sys.exit("psycopg2 is required:  pip install psycopg2-binary")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "..")          # "github version/"
ROOT = os.path.join(REPO, "..")          # IVDA/


def backfill_geometry(cur, gazetteer_path, only_missing=True):
    print(f"Loading gazetteer {gazetteer_path} ...")
    with open(gazetteer_path, encoding="utf-8") as fh:
        gaz = json.load(fh)
    print(f"  {len(gaz):,} entries")

    # Keys look like "London|" or "London|United Kingdom". Index by bare name;
    # first entry wins, which matches how the original pipeline resolved them.
    by_name = {}
    for key, val in gaz.items():
        name = key.split("|", 1)[0]
        if name and name not in by_name:
            by_name[name] = val

    where = "WHERE geometry IS NULL" if only_missing else ""
    cur.execute(f"SELECT id, name FROM geolocations {where};")
    targets = cur.fetchall()
    print(f"  {len(targets):,} geolocation rows to fill")

    updates = []
    for gid, name in targets:
        hit = by_name.get(name)
        if not hit or not hit.get("geometry"):
            continue
        updates.append((
            hit.get("country"),
            hit.get("country_code"),
            hit.get("continent"),
            hit["geometry"],           # "POINT(lon lat)" WKT
            gid,
        ))

    print(f"  {len(updates):,} matched the gazetteer")
    execute_batch(
        cur,
        """UPDATE geolocations
              SET country       = COALESCE(%s, country),
                  country_code  = COALESCE(%s, country_code),
                  continent     = COALESCE(%s, continent),
                  geometry      = ST_GeomFromText(%s, 4326)
            WHERE id = %s;""",
        updates,
        page_size=1000,
    )
    return len(updates)


def backfill_topics(cur, hierarchy_path):
    print(f"Loading topic hierarchy {hierarchy_path} ...")
    with open(hierarchy_path, encoding="utf-8") as fh:
        hierarchy = json.load(fh)

    flat = []

    def walk(nodes):
        for n in nodes:
            if n.get("id"):
                flat.append((n["id"], n.get("name") or n["id"], n.get("words") or []))
            walk(n.get("subtopics") or [])

    walk(hierarchy)
    print(f"  {len(flat):,} topics")

    execute_batch(
        cur,
        """UPDATE topics
              SET name  = %s,
                  words = %s
            WHERE id = %s;""",
        [(name, words, tid) for tid, name, words in flat],
        page_size=200,
    )

    # Report anything the hierarchy knows about but the database does not.
    cur.execute("SELECT id FROM topics;")
    db_ids = {r[0] for r in cur.fetchall()}
    unknown = [t for t, _, _ in flat if t not in db_ids]
    if unknown:
        print(f"  WARNING: {len(unknown)} topics in the hierarchy are absent "
              f"from the topics table: {unknown[:10]}")
    return len(flat)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default=os.environ.get(
        "DATABASE_URL", "postgresql://karina@localhost:5432/ord_xplore"))
    ap.add_argument("--gazetteer", default=os.path.join(
        ROOT, "data", "pipeline", "visualisation_prep", "geo_data", "geocoding_map.json"))
    ap.add_argument("--topics", default=os.path.join(
        REPO, "app", "topics_hierarchy.json"))
    ap.add_argument("--all-geometry", action="store_true",
                    help="overwrite existing geometry, not just NULL rows")
    args = ap.parse_args()

    conn = psycopg2.connect(args.dsn)
    cur = conn.cursor()

    n_geo = backfill_geometry(cur, args.gazetteer, only_missing=not args.all_geometry)
    n_top = backfill_topics(cur, args.topics)

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM geolocations WHERE geometry IS NOT NULL;")
    have_geom = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM geolocations;")
    total_geo = cur.fetchone()[0]

    cur.close()
    conn.close()

    print()
    print(f"Done. Updated {n_geo:,} geolocations and {n_top:,} topics.")
    print(f"      {have_geom:,}/{total_geo:,} geolocations now have coordinates.")
    if have_geom == 0:
        print("      Nothing was geocoded -- check that PostGIS is installed "
              "(CREATE EXTENSION postgis;).")


if __name__ == "__main__":
    main()
