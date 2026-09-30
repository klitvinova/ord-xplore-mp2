#!/usr/bin/env python3
"""
1. Seeds `tei_tag_definitions` with semantic descriptions from the TEI P5 Guidelines.
2. Extracts document-level tag values and attributes from raw TEI XML files into `document_tag_values`.

Usage:
    python3 db/007_populate_tei_guidelines_and_tag_values.py [--limit-editions 10] [--dsn postgresql://karina@localhost:5432/ord_xplore]

Idempotent. Safe to re-run.
"""

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    sys.exit("psycopg2 is required: pip install psycopg2-binary")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "..")
RAW_DIR = os.path.join(REPO, "..", "raw_documents")
DASHBOARD_JSON = os.path.join(REPO, "..", "dashboard_data.json")

# TEI P5 Guideline Definitions Catalog
TEI_GUIDELINES = [
    # --- Names & Entities ---
    ("persName", "Names & Entities", "Contains a proper noun or noun phrase referring to a person.", ["person", "people", "name", "who", "author", "recipient", "individual"]),
    ("placeName", "Names & Entities", "Contains an absolute or relative place name, city, country, or geographical location.", ["place", "location", "city", "country", "where", "geography", "town", "region"]),
    ("orgName", "Names & Entities", "Contains an organization name (institution, society, company, university, parliament).", ["organization", "institution", "society", "company", "group", "association"]),
    ("rs", "Names & Entities", "Referencing string: general named entity reference to a person, place, or thing.", ["reference", "entity", "mentioned", "item"]),
    ("name", "Names & Entities", "Contains a proper noun or name for any entity.", ["name", "named"]),
    ("forename", "Names & Entities", "Contains a first name, given name, or baptismal name.", ["first name", "given name", "forename"]),
    ("surname", "Names & Entities", "Contains a family name or surname.", ["last name", "surname", "family name"]),
    ("roleName", "Names & Entities", "Contains a title or role (e.g. King, Bishop, Professor, General).", ["title", "role", "profession", "rank"]),
    ("occupation", "Names & Entities", "Specifies an occupation, profession, or craft.", ["occupation", "job", "career", "trade", "profession"]),
    ("residence", "Names & Entities", "Specifies a person's current or past residence.", ["residence", "dwelling", "living in", "resident"]),

    # --- Dates & Time ---
    ("date", "Dates & Time", "Contains a date in any format (e.g. year, ISO date, textual date).", ["date", "year", "when", "time", "century", "period", "timeline", "day", "month"]),
    ("time", "Dates & Time", "Contains a phrase defining a time of day or precise timestamp.", ["time", "hour", "clock", "timestamp"]),
    ("origDate", "Dates & Time", "Date on which a manuscript or original text was composed.", ["creation date", "original date", "composition"]),
    ("docDate", "Dates & Time", "Document date as recorded in the manuscript or publication heading.", ["document date"]),

    # --- Correspondence ---
    ("correspAction", "Correspondence", "Contains actions in correspondence (sender, recipient, place, and date of sending or receiving).", ["letter", "correspondence", "sender", "recipient", "sent", "received", "addressed to"]),
    ("correspDesc", "Correspondence", "Describes the actions related to one letter or communication.", ["correspondence description", "letters"]),
    ("opener", "Correspondence", "Groups together opening formulas of a letter (date, place, salutation).", ["letter opening", "greeting", "salutation", "letter start"]),
    ("salute", "Correspondence", "Contains a formal salutation or greeting ('Dear Sir', 'My Lord').", ["salutation", "greeting", "dear sir", "dear madam"]),
    ("closer", "Correspondence", "Groups together closing formulas of a letter (farewell, signature, date).", ["letter closing", "farewell", "sign-off"]),
    ("signed", "Correspondence", "Contains the closing salutation, signature, or sign-off mark of a letter.", ["signature", "signed by", "signatory", "autograph", "mark"]),
    ("postscript", "Correspondence", "Contains a postscript (P.S.) appended to a letter.", ["postscript", "ps", "appended note"]),
    ("address", "Correspondence", "Contains a postal address or destination.", ["address", "destination", "postal"]),

    # --- Poetry & Verse ---
    ("lg", "Poetry & Verse", "Line group: contains one or more verse lines forming a formal unit (e.g. stanza, verse).", ["poetry", "verse", "stanza", "poem", "rhyme", "song", "hymn"]),
    ("l", "Poetry & Verse", "Contains a single line of verse or poetry.", ["verse line", "line of poetry", "poetic"]),
    ("rhyme", "Poetry & Verse", "Marks the rhyming word or syllable in a poetic line.", ["rhyme", "rhyme scheme"]),

    # --- Drama & Dialogue ---
    ("sp", "Drama & Dialogue", "Speech: contains an individual speech or turn in a dramatic text.", ["speech", "drama", "play", "theatre", "theatrical", "dialogue", "scene"]),
    ("speaker", "Drama & Dialogue", "Contains the name of the speaker delivering a dramatic speech.", ["speaker", "character", "actor"]),
    ("stage", "Drama & Dialogue", "Contains any stage direction in a dramatic text.", ["stage direction", "enters", "exits", "scene direction"]),
    ("said", "Drama & Dialogue", "Indicates direct speech or thoughts attributed to a speaker.", ["direct speech", "quotes", "spoken words", "dialogue"]),
    ("q", "Drama & Dialogue", "Separated quote, quotation, or dialogue fragment.", ["quotation", "quote"]),
    ("quote", "Drama & Dialogue", "Explicit quotation from an external source or speaker.", ["citation", "quoted text"]),

    # --- Manuscript & Epigraphy ---
    ("msDesc", "Manuscript & Epigraphy", "Detailed manuscript description (codicology, palaeography, provenance).", ["manuscript", "codex", "handwriting", "scribal", "parchment"]),
    ("handDesc", "Manuscript & Epigraphy", "Describes the scribal hands or handwriting present in a manuscript.", ["handwriting", "scribal hand", "script"]),
    ("physDesc", "Manuscript & Epigraphy", "Physical description of the carrier, paper, ink, or binding.", ["physical description", "binding", "paper", "parchment"]),
    ("handShift", "Manuscript & Epigraphy", "Marks a change of scribal hand or script in a manuscript.", ["hand change", "different hand"]),
    ("expan", "Manuscript & Epigraphy", "Contains the expansion of an abbreviation.", ["expansion", "abbreviation expansion", "epigraphy"]),
    ("abbr", "Manuscript & Epigraphy", "Contains any abbreviation in the text.", ["abbreviation", "short form"]),
    ("epigraph", "Manuscript & Epigraphy", "Contains a quotation, anonymous motto, or inscription heading.", ["epigraph", "inscription", "motto"]),
    ("rubric", "Manuscript & Epigraphy", "Heading or text written in red ink or distinctive script in a manuscript.", ["rubric", "red ink", "manuscript heading"]),
    ("stamp", "Manuscript & Epigraphy", "Contains a stamp, postage mark, or institutional cachet on the document.", ["stamp", "postage", "cachet"]),
    ("seal", "Manuscript & Epigraphy", "Contains a wax seal, lead bulla, or impressed seal on the document.", ["seal", "wax seal", "bulla"]),

    # --- Editorial & Text Critical ---
    ("corr", "Editorial", "Contains the correct form of a passage as emended by the editor.", ["correction", "editorial correction"]),
    ("sic", "Editorial", "Contains text reproduced exactly as original despite an apparent error.", ["sic", "original error"]),
    ("choice", "Editorial", "Groups alternative encodings (e.g. original vs modernized, abbreviation vs expansion).", ["choice", "variants", "modernized"]),
    ("reg", "Editorial", "Contains a reading that has been regularized or normalized.", ["regularized", "normalized"]),
    ("orig", "Editorial", "Contains the original, un-regularized reading from the source.", ["original spelling", "source text"]),
    ("supplied", "Editorial", "Contains text supplied by the transcriber or editor in place of damaged text.", ["supplied text", "editorial addition"]),
    ("unclear", "Editorial", "Contains a passage that cannot be transcribed with certainty.", ["unclear", "uncertain reading", "illegible"]),
    ("gap", "Editorial", "Marks a point where text has been omitted or lost due to physical damage.", ["gap", "lacuna", "missing text", "damaged"]),
    ("damage", "Editorial", "Describes an area of physical damage on the source carrier.", ["damage", "torn", "faded", "wormholes"]),
    ("note", "Editorial", "Contains an annotation, footnote, endnote, or commentary.", ["note", "footnote", "annotation", "commentary", "gloss"]),

    # --- Linguistic & Lexicographical ---
    ("entry", "Linguistic", "Contains a single structured dictionary or glossary entry.", ["dictionary", "glossary entry", "lexicon", "lexicographical"]),
    ("form", "Linguistic", "Contains word forms, inflections, or pronunciations in a dictionary entry.", ["word form", "inflection"]),
    ("gloss", "Linguistic", "Contains a definition, explanation, or gloss for a term or foreign word.", ["gloss", "definition", "meaning", "explanation"]),
    ("term", "Linguistic", "Contains a technical, specialist, or indexed term.", ["term", "terminology", "technical term"]),
    ("w", "Linguistic", "Represents a single grammatical word token.", ["word", "token", "linguistic word"]),
    ("m", "Linguistic", "Represents a morpheme or grammatical subunit.", ["morpheme", "grammar"]),
    ("c", "Linguistic", "Represents a single character token.", ["character", "letter token"]),
    ("pc", "Linguistic", "Represents a punctuation character token.", ["punctuation"]),
    ("s", "Linguistic", "Represents a sentence or clause division.", ["sentence", "clause"]),
    ("foreign", "Linguistic", "Identifies a word or phrase belonging to a foreign language.", ["foreign language", "latin phrase", "foreign word"]),

    # --- Publication & Structure ---
    ("title", "Publication & Structure", "Contains a title for any kind of work, chapter, or letter.", ["title", "work", "headline", "document title"]),
    ("author", "Publication & Structure", "Contains the name of the author or creator.", ["author", "writer", "creator", "composed by"]),
    ("publisher", "Publication & Structure", "Name of the publisher or distributor.", ["publisher", "published by", "press", "printing"]),
    ("pubPlace", "Publication & Structure", "Place of publication.", ["publication place", "published at", "imprint place"]),
    ("licence", "Publication & Structure", "Contains information about the legal licence, copyright, or reuse permissions.", ["licence", "license", "copyright", "rights", "creative commons", "public domain", "cc-by"]),
    ("bibl", "Publication & Structure", "Contains a loosely-structured bibliographic citation.", ["citation", "bibliography", "source work", "reference"]),
    ("head", "Publication & Structure", "Heading for any section, division, chapter, poem, or letter.", ["heading", "section title", "chapter heading", "header"]),
    ("p", "Publication & Structure", "Marks a standard paragraph in prose.", ["paragraph", "prose"]),
    ("hi", "Publication & Structure", "Marks highlighted, emphasized, bold, italicized, or rubricated text.", ["highlighted", "emphasis", "bold", "italic", "underline"])
]

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

# Tags to extract document-level values from
EXTRACTABLE_TAGS = {
    'persName', 'placeName', 'orgName', 'date', 'title', 'author',
    'opener', 'salute', 'signed', 'lg', 'sp', 'speaker', 'said',
    'term', 'gloss', 'bibl', 'licence', 'stamp', 'seal', 'epigraph',
    'rs', 'name', 'forename', 'surname', 'roleName', 'occupation',
    'head', 'note', 'foreign', 'entry', 'expan', 'abbr'
}


def strip_tag(tag):
    if isinstance(tag, str) and '}' in tag:
        return tag.split('}', 1)[1]
    return tag or ''


def extract_tag_values_from_file(file_path):
    """Extracts tag text and key attributes for all semantic tags in the XML."""
    tag_values = []
    seen = set()

    try:
        tree = ET.parse(file_path)
        root = tree.getroot()

        for elem in root.iter():
            tag = strip_tag(elem.tag)
            if tag in EXTRACTABLE_TAGS:
                # 1. Inner Text Value
                text_val = "".join(elem.itertext()).strip()
                if text_val and len(text_val) <= 500:
                    key = (tag, None, text_val)
                    if key not in seen:
                        seen.add(key)
                        tag_values.append((tag, None, text_val, 1))

                # 2. Key Attributes (@when, @type, @ref, @key, @sex, @role)
                for attr_name, attr_val in elem.attrib.items():
                    local_attr = strip_tag(attr_name)
                    val_str = str(attr_val).strip()
                    if local_attr in ('when', 'type', 'subtype', 'ref', 'key', 'sex', 'role', 'where') and val_str:
                        key = (tag, local_attr, val_str)
                        if key not in seen:
                            seen.add(key)
                            tag_values.append((tag, local_attr, val_str, 1))

    except Exception:
        return None

    return tag_values


def worker_job(job):
    pk, rel_path = job
    full_path = os.path.join(RAW_DIR, rel_path)
    if not os.path.exists(full_path):
        return pk, None
    tag_vals = extract_tag_values_from_file(full_path)
    return pk, tag_vals


def main():
    parser = argparse.ArgumentParser(description="Populate TEI guidelines and extract document tag values")
    parser.add_argument("--dsn", default=os.getenv("DATABASE_URL") or "postgresql://karina@localhost:5432/ord_xplore")
    parser.add_argument("--limit-editions", type=int, default=10)
    parser.add_argument("--all-editions", action="store_true", help="Extract across all editions in database")
    args = parser.parse_args()

    conn = psycopg2.connect(args.dsn)
    conn.autocommit = False
    cur = conn.cursor()

    try:
        # 1. Populate TEI Guideline Definitions
        print(f"Upserting {len(TEI_GUIDELINES)} TEI Guideline definitions into `tei_tag_definitions`...")
        for name, category, desc, examples in TEI_GUIDELINES:
            cur.execute("""
                INSERT INTO tei_tag_definitions (name, category, description, example_queries)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (name) DO UPDATE
                SET category = EXCLUDED.category,
                    description = EXCLUDED.description,
                    example_queries = EXCLUDED.example_queries;
            """, (name, category, desc, examples))

        conn.commit()
        print("✅ `tei_tag_definitions` populated successfully.")

        # 2. Extract Document-level Tag Values
        if args.all_editions or args.limit_editions == 0:
            cur.execute("SELECT id, name FROM editions;")
            target_ed_map = {row[1]: row[0] for row in cur.fetchall()}
            target_editions = list(target_ed_map.keys())
            print(f"\nTargeting ALL {len(target_editions)} editions in database for tag-value extraction.")
        else:
            target_editions = TARGET_EDITIONS[:args.limit_editions]
            print(f"\nTargeting {len(target_editions)} editions for document tag-value extraction: {target_editions}")
            cur.execute("SELECT id, name FROM editions WHERE name = ANY(%s);", (target_editions,))
            target_ed_map = {row[1]: row[0] for row in cur.fetchall()}

        with open(DASHBOARD_JSON, encoding="utf-8") as f:
            docs = json.load(f)

        target_ed_ids = set(target_ed_map.values())
        cur.execute("SELECT id, edition_id FROM documents WHERE edition_id = ANY(%s);", (list(target_ed_ids),))
        db_target_docs = {row[0]: row[1] for row in cur.fetchall()}
        print(f"Found {len(db_target_docs):,} documents in target editions.")

        jobs = []
        for idx, doc_meta in enumerate(docs):
            pk = idx + 1
            if pk in db_target_docs:
                rel_path = doc_meta.get("id")
                if rel_path:
                    jobs.append((pk, rel_path))

        print(f"Extracting tag-value pairs from {len(jobs):,} documents...")

        success_docs = 0
        batch_size = 50000
        current_batch = []
        total_inserted = 0

        # Clear existing document_tag_values for target editions to allow clean re-run
        cur.execute("TRUNCATE TABLE document_tag_values;")
        conn.commit()

        with ProcessPoolExecutor(max_workers=os.cpu_count() or 4) as executor:
            for pk, tag_vals in executor.map(worker_job, jobs, chunksize=100):
                if tag_vals:
                    success_docs += 1
                    for tag_name, attr_name, val, occurrences in tag_vals:
                        current_batch.append((pk, tag_name, attr_name, val, occurrences))
                        if len(current_batch) >= batch_size:
                            execute_values(cur, """
                                INSERT INTO document_tag_values (document_id, tag_name, attribute_name, value, occurrences)
                                VALUES %s;
                            """, current_batch)
                            conn.commit()
                            total_inserted += len(current_batch)
                            current_batch = []
                            print(f"  Inserted {total_inserted:,} rows so far ({success_docs:,} docs parsed)...")

        if current_batch:
            execute_values(cur, """
                INSERT INTO document_tag_values (document_id, tag_name, attribute_name, value, occurrences)
                VALUES %s;
            """, current_batch)
            conn.commit()
            total_inserted += len(current_batch)

        print(f"✅ Successfully inserted {total_inserted:,} document tag-value records across {success_docs:,} documents in {len(target_editions)} editions!")

    except Exception as e:
        conn.rollback()
        print(f"❌ Error populating guidelines and tag values: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
