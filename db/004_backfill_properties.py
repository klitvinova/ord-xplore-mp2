#!/usr/bin/env python3
"""
Backfill dynamic properties and property values from the Metadata Curation Framework (MCF)
dataset into the ord_xplore database.

Usage:
    python3 db/004_backfill_properties.py [--limit 10] [--dsn postgresql://karina@localhost:5432/ord_xplore]

Idempotent. Safe to re-run.
"""

import argparse
import json
import os
import sys

try:
    import psycopg2
    from psycopg2.extras import execute_values, Json
except ImportError:
    sys.exit("psycopg2 is required: pip install psycopg2-binary")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "..")
DATA_PATH = os.path.join(REPO, "..", "metadata-curation-framework", "projects", "digital_editions", "mp_karina", "data", "metadata_editions.json")


def infer_vocabularies(data):
    languages = set()
    for entry in data.get("language", {}).values():
        if isinstance(entry, dict):
            for code in entry.get("codes", []):
                if code:
                    languages.add(code)

    doc_types = set()
    for entry in data.get("doc_type", {}).values():
        if isinstance(entry, dict):
            for val in entry.get("values", []):
                if val:
                    doc_types.add(val)

    rights = set()
    for entry in data.get("rights", {}).values():
        if isinstance(entry, dict):
            for val in entry.get("values", []):
                if val:
                    rights.add(val)

    return sorted(languages), sorted(doc_types), sorted(rights)


def get_property_definitions(languages, doc_types, rights):
    return [
        ("contains_verse", "Contains Verse", "binary", "Whether the edition contains verse", []),
        ("contains_linguistic_annotation", "Contains Linguistic Annotation", "binary", "Whether the edition contains linguistic annotation", []),
        ("contains_direct_speech", "Contains Direct Speech", "binary", "Whether the edition contains direct speech", []),
        ("contains_east_asian_scripts", "Contains East Asian Scripts", "binary", "Whether East Asian scripts are present", []),
        ("contains_japanese_scripts", "Contains Japanese Scripts", "binary", "Whether Japanese scripts are present", []),
        ("contains_newspaper_articles", "Contains Newspaper Articles", "binary", "Whether the edition contains newspaper articles", []),
        ("is_manuscript", "Is Manuscript", "binary", "Whether the edition is manuscript-based", []),
        ("contains_inscriptions", "Contains Inscriptions", "binary", "Whether the edition contains inscriptions", []),
        ("contains_dictionary", "Contains Dictionary", "binary", "Whether the edition contains dictionary-like material", []),
        ("is_letter", "Is Letter", "binary", "Whether the edition contains letters", []),
        ("is_political_letter", "Is Political Letter", "binary", "Whether the edition contains political letters", []),
        ("contains_law_texts", "Contains Law Texts", "binary", "Whether the edition contains legal texts", []),
        ("contains_diary", "Contains Diary", "binary", "Whether the edition contains diary material", []),
        ("is_medieval_manuscript", "Is Medieval Manuscript", "binary", "Whether the edition is a medieval manuscript", []),
        ("contains_theatre", "Contains Theatre", "binary", "Whether the edition contains theatre content", []),
        ("is_historic", "Is Historic", "binary", "Whether the edition is historic", []),
        ("contains_political_protocols", "Contains Political Protocols", "binary", "Whether the edition contains political protocols", []),
        ("doc_count", "Document Count", "numerical", "Number of documents in the edition", []),
        ("publication_date", "Publication Date", "free_text", "The range of publication dates for the edition", []),
        ("contextual_date", "Contextual Date", "free_text", "The range of contextual dates for the edition", []),
        ("language", "Language", "multiple_choice", "Language codes of the source material", languages),
        ("people_genders", "People Genders", "multiple_choice", "Genders of the people mentioned in the edition", ["male", "female"]),
        ("doc_type", "Document Type", "multiple_choice", "Document type values for the edition", doc_types),
        ("flags_signed", "Signed", "binary", "Whether the document is signed", []),
        ("flags_stamp", "Stamp", "binary", "Whether the document bears a stamp", []),
        ("title", "Title", "free_text", "Title of the edition", []),
        ("rights", "Rights", "multiple_choice", "Rights or license information for the edition", rights),
        ("institutions", "Institutions", "free_text", "Institutions associated with the edition", []),
        ("citations_relations", "Citations Relations", "free_text", "Citations and relations object", []),
        ("edition_info", "Edition Info", "free_text", "Edition information", [])
    ]


def extract_suggestions(props):
    suggestions = {}
    binary_props = [
        "contains_verse", "contains_linguistic_annotation", "contains_direct_speech",
        "contains_east_asian_scripts", "contains_japanese_scripts",
        "contains_newspaper_articles", "is_manuscript", "contains_inscriptions",
        "contains_dictionary", "is_letter", "is_political_letter", "contains_law_texts",
        "contains_diary", "is_medieval_manuscript", "contains_theatre",
        "is_historic", "contains_political_protocols",
    ]
    for p in binary_props:
        val = props.get(p)
        if isinstance(val, bool):
            suggestions[p] = val

    doc_count = props.get("doc_count")
    if isinstance(doc_count, (int, float)):
        suggestions["doc_count"] = doc_count

    for date_prop in ("publication_date", "contextual_date"):
        entry = props.get(date_prop)
        if isinstance(entry, dict) and entry.get("range"):
            suggestions[date_prop] = entry["range"]

    title_entry = props.get("title")
    if isinstance(title_entry, dict) and title_entry.get("value"):
        suggestions["title"] = title_entry["value"]

    lang_entry = props.get("language")
    if isinstance(lang_entry, dict):
        codes = [c for c in lang_entry.get("codes", []) if c]
        if codes:
            suggestions["language"] = codes

    people_entry = props.get("people")
    if isinstance(people_entry, dict):
        genders = [g for g in people_entry.get("genders", []) if g]
        if genders:
            suggestions["people_genders"] = genders

    for prop in ("doc_type", "rights"):
        entry = props.get(prop)
        if isinstance(entry, dict):
            values = [v for v in entry.get("values", []) if v]
            if values:
                suggestions[prop] = values

    flags_entry = props.get("flags")
    if isinstance(flags_entry, dict):
        if isinstance(flags_entry.get("signed"), bool):
            suggestions["flags_signed"] = flags_entry["signed"]
        if isinstance(flags_entry.get("stamp"), bool):
            suggestions["flags_stamp"] = flags_entry["stamp"]

    for prop in ("institutions", "citations_relations", "edition_info"):
        entry = props.get(prop)
        if isinstance(entry, dict):
            values = [str(v) for v in entry.get("values", []) if v]
            if values:
                suggestions[prop] = "; ".join(values)

    return suggestions


def pivot_data(data):
    editions = {}
    for prop_name, edition_map in data.items():
        if not isinstance(edition_map, dict):
            continue
        for ed_id, val in edition_map.items():
            editions.setdefault(ed_id, {})[prop_name] = val
    return editions


def main():
    parser = argparse.ArgumentParser(description="Backfill dynamic properties into ord_xplore")
    parser.add_argument("--dsn", default=os.getenv("DATABASE_URL") or "postgresql://karina@localhost:5432/ord_xplore")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of editions to import")
    args = parser.parse_args()

    print(f"Connecting to {args.dsn} ...")
    conn = psycopg2.connect(args.dsn)
    conn.autocommit = False
    cur = conn.cursor()

    try:
        if not os.path.exists(DATA_PATH):
            sys.exit(f"Data file not found at {DATA_PATH}")

        print(f"Loading MCF source data from {DATA_PATH} ...")
        with open(DATA_PATH, encoding="utf-8") as f:
            data = json.load(f)

        languages, doc_types, rights = infer_vocabularies(data)
        prop_defs = get_property_definitions(languages, doc_types, rights)

        print(f"Upserting {len(prop_defs)} dynamic property definitions...")
        for name, display_name, prop_type, description, options in prop_defs:
            cur.execute("""
                INSERT INTO properties (name, display_name, type, description, options)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (name) DO UPDATE
                SET display_name = EXCLUDED.display_name,
                    type = EXCLUDED.type,
                    description = EXCLUDED.description,
                    options = EXCLUDED.options;
            """, (name, display_name, prop_type, description, Json(options)))

        # Load property name -> id mapping
        cur.execute("SELECT name, id FROM properties;")
        prop_map = {row[0]: row[1] for row in cur.fetchall()}

        # Load database editions (name.lower() -> id)
        cur.execute("SELECT id, name FROM editions;")
        db_editions = {row[1].lower(): row[0] for row in cur.fetchall()}

        pivoted = pivot_data(data)
        edition_keys = sorted(pivoted.keys())

        if args.limit:
            edition_keys = edition_keys[:args.limit]
            print(f"Limiting import to first {args.limit} editions: {edition_keys}")

        edition_values_to_insert = []
        matched_editions = 0

        for ed_key in edition_keys:
            ed_props = pivoted[ed_key]
            db_ed_id = db_editions.get(ed_key.lower())
            if not db_ed_id:
                continue

            matched_editions += 1
            suggestions = extract_suggestions(ed_props)
            for prop_name, val in suggestions.items():
                prop_id = prop_map.get(prop_name)
                if prop_id:
                    edition_values_to_insert.append((db_ed_id, prop_id, Json(val)))

        print(f"Matched {matched_editions} editions in database. Inserting {len(edition_values_to_insert)} edition property values...")

        execute_values(cur, """
            INSERT INTO edition_property_values (edition_id, property_id, value)
            VALUES %s
            ON CONFLICT (edition_id, property_id) DO UPDATE
            SET value = EXCLUDED.value;
        """, edition_values_to_insert)

        conn.commit()
        print(f"✅ Successfully backfilled {len(prop_defs)} properties and {len(edition_values_to_insert)} property values for {matched_editions} editions!")

    except Exception as e:
        conn.rollback()
        print(f"❌ Backfill failed: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
