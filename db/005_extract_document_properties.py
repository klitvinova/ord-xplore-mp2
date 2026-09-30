#!/usr/bin/env python3
"""
Extract fine-grained document-level dynamic properties directly from raw TEI XML files
and populate the `document_property_values` table in ord_xplore.

Usage:
    python3 db/005_extract_document_properties.py [--editions 10] [--dsn postgresql://karina@localhost:5432/ord_xplore]

Idempotent. Safe to re-run.
"""

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed

try:
    import psycopg2
    from psycopg2.extras import execute_values, Json
except ImportError:
    sys.exit("psycopg2 is required: pip install psycopg2-binary")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "..")
RAW_DIR = os.path.join(REPO, "..", "raw_documents")
DASHBOARD_JSON = os.path.join(REPO, "..", "dashboard_data.json")

TARGET_EDITIONS = [
    'thomas_gray_poems',
    'Robert_Walser',
    'okopenko_diaries',
    'familienkorrespondenz_ferdinands_I',
    'Iurisprudentia',
    'eigtheenth_century_french_novels',
    'four_early_chan_texts',
    'telamon_bulgaria',
    'quellen_habsburgisch_osmanische_diplomatie',
    'schnitzler_lektüren'
]

CJK_REGEX = re.compile(r'[\u4e00-\u9fff]')
JAPANESE_REGEX = re.compile(r'[\u3040-\u30ff]')


def strip_tag(tag):
    if isinstance(tag, str) and '}' in tag:
        return tag.split('}', 1)[1]
    return tag or ''


def extract_document_properties_from_xml(file_path):
    """Parses a raw TEI XML file and extracts fine-grained properties."""
    tags = set()
    attributes = Counter()
    dates = []
    people_genders = set()
    doc_types = set()
    rights = set()
    text_buffer = []
    title = None

    try:
        # Full tree parse for deep attributes and text
        tree = ET.parse(file_path)
        root = tree.getroot()

        for elem in root.iter():
            tag = strip_tag(elem.tag)
            tags.add(tag)

            if elem.text:
                text_buffer.append(elem.text)

            # Attributes extraction
            for attr_name, attr_val in elem.attrib.items():
                local_attr = strip_tag(attr_name)
                val_str = str(attr_val).strip()
                attributes[f"{tag}@{local_attr}"] += 1

                # Detect types
                if local_attr == 'type' and val_str:
                    doc_types.add(val_str.lower())

                # Detect sex/gender
                if local_attr == 'sex' and val_str:
                    g = val_str.lower()
                    if g in ('1', 'm', 'male'):
                        people_genders.add('male')
                    elif g in ('2', 'f', 'female'):
                        people_genders.add('female')

                # Detect dates
                if local_attr in ('when', 'notBefore', 'notAfter', 'from', 'to'):
                    match = re.search(r'\b(1\d{3}|20\d{2})\b', val_str)
                    if match:
                        dates.append(int(match.group(1)))

            # Specific tags
            if tag == 'title' and not title and elem.text:
                title = elem.text.strip()

            if tag in ('licence', 'availability') and elem.text:
                rights.add(elem.text.strip()[:100])

    except Exception:
        return None

    full_text = " ".join(text_buffer)
    word_count = len(full_text.split())

    # Build Property Values
    props = {}

    # 1. Binary Features
    props["contains_verse"] = 'l' in tags or 'lg' in tags
    props["contains_direct_speech"] = bool(tags & {'said', 'q', 'quote', 'speech'})
    props["contains_linguistic_annotation"] = bool(tags & {'w', 'c', 'm', 'pc', 'cl'})
    props["contains_east_asian_scripts"] = bool(CJK_REGEX.search(full_text))
    props["contains_japanese_scripts"] = bool(JAPANESE_REGEX.search(full_text))
    props["contains_newspaper_articles"] = 'newspaper' in doc_types or 'article' in doc_types
    props["is_manuscript"] = bool(tags & {'msDesc', 'handDesc', 'physDesc', 'handShift'})
    props["contains_inscriptions"] = bool(tags & {'expan', 'epigraph', 'rubric'}) or 'inscription' in doc_types
    props["contains_dictionary"] = bool(tags & {'entry', 'dictScrap', 'form', 'sense', 'def'})
    props["is_letter"] = bool(tags & {'opener', 'salute', 'closer', 'correspAction'}) or 'letter' in doc_types
    props["is_political_letter"] = props["is_letter"] and any(w in full_text.lower() for w in ['majestät', 'kaiser', 'minister', 'botschaft', 'senat', 'politisch'])
    props["contains_law_texts"] = any(w in doc_types for w in ['statute', 'law', 'act', 'ordinance', 'legal']) or any(w in full_text.lower() for w in ['haftung', 'gesetz', 'urteil', 'paragraph'])
    props["contains_diary"] = 'diary' in doc_types or 'journal' in doc_types or ('entry' in tags and bool(dates))
    props["is_medieval_manuscript"] = props["is_manuscript"] and any(d < 1500 for d in dates)
    props["contains_theatre"] = bool(tags & {'sp', 'speaker', 'stage'})
    props["is_historic"] = any(d <= 1950 for d in dates) if dates else True
    props["contains_political_protocols"] = 'protocol' in doc_types or 'meeting' in tags
    props["flags_signed"] = 'signed' in tags
    props["flags_stamp"] = bool(tags & {'stamp', 'seal'})

    # 2. Multiple Choice / Categoricals
    if people_genders:
        props["people_genders"] = sorted(people_genders)
    if doc_types:
        props["doc_type"] = sorted(list(doc_types)[:5])
    if rights:
        props["rights"] = sorted(list(rights)[:3])

    # 3. Free text / Numerical
    if title:
        props["title"] = title[:255]
    if dates:
        min_y, max_y = min(dates), max(dates)
        props["contextual_date"] = f"{min_y}-{max_y}" if min_y != max_y else str(min_y)

    return props


def process_single_doc(job):
    pk, rel_path = job
    full_path = os.path.join(RAW_DIR, rel_path)
    if not os.path.exists(full_path):
        return pk, None
    props = extract_document_properties_from_xml(full_path)
    return pk, props


def main():
    parser = argparse.ArgumentParser(description="Extract document-level dynamic properties from raw XMLs")
    parser.add_argument("--dsn", default=os.getenv("DATABASE_URL") or "postgresql://karina@localhost:5432/ord_xplore")
    parser.add_argument("--limit-editions", type=int, default=10, help="Number of target editions to process")
    args = parser.parse_args()

    target_editions = TARGET_EDITIONS[:args.limit_editions]
    print(f"Targeting {len(target_editions)} editions: {target_editions}")

    print(f"Loading {DASHBOARD_JSON} ...")
    with open(DASHBOARD_JSON, encoding="utf-8") as f:
        docs = json.load(f)

    conn = psycopg2.connect(args.dsn)
    conn.autocommit = False
    cur = conn.cursor()

    try:
        # Load properties map: name -> id
        cur.execute("SELECT name, id FROM properties;")
        prop_map = {row[0]: row[1] for row in cur.fetchall()}

        # Load edition IDs
        cur.execute("SELECT id, name FROM editions WHERE name = ANY(%s);", (target_editions,))
        target_ed_map = {row[1]: row[0] for row in cur.fetchall()}
        target_ed_ids = set(target_ed_map.values())
        print(f"Found {len(target_ed_map)} matching edition records in database.")

        # Identify documents belonging to target editions
        cur.execute("SELECT id, edition_id FROM documents WHERE edition_id = ANY(%s);", (list(target_ed_ids),))
        db_target_docs = {row[0]: row[1] for row in cur.fetchall()}
        print(f"Total documents in database for target editions: {len(db_target_docs):,}")

        # Build work list
        jobs = []
        for idx, doc_meta in enumerate(docs):
            pk = idx + 1
            if pk in db_target_docs:
                rel_path = doc_meta.get("id")
                if rel_path:
                    jobs.append((pk, rel_path))

        print(f"Prepared {len(jobs)} document extraction jobs. Processing with multi-core pool...")

        doc_values_to_insert = []
        processed_count = 0
        success_count = 0

        with ProcessPoolExecutor(max_workers=os.cpu_count() or 4) as executor:
            for pk, props in executor.map(process_single_doc, jobs):
                processed_count += 1
                if props:
                    success_count += 1
                    for prop_name, val in props.items():
                        prop_id = prop_map.get(prop_name)
                        if prop_id:
                            doc_values_to_insert.append((pk, prop_id, Json(val)))

        print(f"Extraction complete: {success_count}/{len(jobs)} documents successfully extracted.")
        print(f"Inserting {len(doc_values_to_insert):,} document property values into `document_property_values`...")

        execute_values(cur, """
            INSERT INTO document_property_values (document_id, property_id, value)
            VALUES %s
            ON CONFLICT (document_id, property_id) DO UPDATE
            SET value = EXCLUDED.value;
        """, doc_values_to_insert)

        conn.commit()
        print(f"✅ Successfully extracted and saved {len(doc_values_to_insert):,} fine-grained document properties across {success_count} documents in {len(target_editions)} editions!")

    except Exception as e:
        conn.rollback()
        print(f"❌ Error extracting document properties: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
