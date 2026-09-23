# Deploying the `clean-deploy` branch to Vercel

## Why the intent-detection merge broke production

The dashboard and search code now query tables that come from migrations
003–007. Those migrations were never committed, so the production database
(loaded from an older dump) doesn't have them. Reproduced against `db_dump.sql`:

| Request | Before (`6b85d52`) | `clean-deploy` |
|---|---|---|
| Toggle any binary feature (e.g. *Letter*) | 500 `edition_property_values does not exist` | 200 |
| Search that yields properties / TEI values | 500 | 200, with skipped filters listed in `warnings` |
| Open a document | 500 `document_tag_values does not exist` | 200 |
| Tag list in "Add Tag" | 503 (misleading "tag tables missing") | 200 |

On `clean-deploy`, the API detects which optional tables exist (`api/_db.js`
`ensureSchema`) and skips only the clauses that need a missing table. Once the
migrations run, the full behaviour comes back automatically.

## Checklist

1. **Vercel env vars** (Production + Preview): `DATABASE_URL`, `GEMINI_API_KEY`,
   `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD`. Optional: `GEMINI_MODEL`,
   `OPENAI_API_KEY`, `ENGINE_MODE`, `CAISI_URL` (only if CaISI is publicly hosted).
2. **Push the branch.** Vercel builds a Preview deployment; `main` stays untouched.
3. **Open `<preview-url>/api/info`.** It shows which engine answers searches and
   `database.missingTables` (anything listed still needs its migration).
4. **Bring the production database up to date**, then re-check `/api/info`.
   You can either:
   - run the migrations against Supabase:
     ```bash
     export DATABASE_URL='postgresql://…supabase…'
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/003_add_properties_and_values.sql
     python3 db/004_backfill_properties.py
     python3 db/005_extract_document_properties.py      # --limit-editions N
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/006_add_tei_guidelines_and_doc_tag_values.sql
     python3 db/007_populate_tei_guidelines_and_tag_values.py --all-editions
     ```
     (005 and 007 read `raw_documents/` from disk, so run them on your Mac.)
   - or dump your local database, which already has everything, and restore it to Supabase.
5. **Smoke test the preview:** load the dashboard, toggle *Letter*, search
   "French letters from the 18th century", open a document, open `upload.html`.
6. **Promote:** merge `clean-deploy` into `main` (or promote the preview in Vercel).

## Known limits on Vercel

- `api/document.js` reads XML from `../../../raw_documents`, which isn't deployed,
  so the XML pane is empty on Vercel (metadata still loads).
- `transparency.html` loads JSON files that are Git LFS pointers or missing
  (`dashboard_data.json`), so it doesn't render on Vercel. This was already the case on `main`.
- `middleware.js` doesn't protect `upload.html` itself (its matcher skips paths
  containing a dot), only the `/api/upload`, `/api/analyze` and `/api/manage` calls it makes.
