import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser } from '@xmldom/xmldom';
import { applyCors, ensureSchema } from './_db.js';

/**
 * POST /api/upload   { filename, content, edition, mode: 'preview' | 'ingest', replace?, newEdition? }
 * GET  /api/upload   -> { available, reason }
 *
 * Uploads use the same extraction as the database build (data/build): the XML
 * is saved to raw_documents/<edition>/<filename> and data/build/ingest.py adds
 * it to the database. 'preview' runs the same extraction on a temporary copy
 * and changes nothing. This needs Python and a writable raw_documents/, so it
 * works on the local server, not on Vercel.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IVDA = path.resolve(__dirname, '../../..');
const RAW_DOCS_ROOT = path.join(IVDA, 'raw_documents');
const INGEST = path.join(IVDA, 'data', 'build', 'ingest.py');
const MAX_CONTENT_BYTES = 25 * 1024 * 1024;
const EDITION_RE = /^[\p{L}\p{N}_-]{2,80}$/u;
const TIMEOUT_MS = 5 * 60 * 1000;

function pythonPath() {
  if (process.env.ORDX_PYTHON) return process.env.ORDX_PYTHON;
  const venv = path.join(IVDA, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

function availability() {
  if (process.env.VERCEL) {
    return { available: false, reason: 'Uploading runs the Python extraction and stores the XML in raw_documents/, so it only works on the local server (node server.js), not on the deployed site.' };
  }
  if (!fs.existsSync(INGEST)) return { available: false, reason: `The ingest script was not found at ${INGEST}.` };
  if (!fs.existsSync(RAW_DOCS_ROOT)) return { available: false, reason: `raw_documents/ was not found at ${RAW_DOCS_ROOT}.` };
  return { available: true };
}

function runIngest(args) {
  return new Promise((resolve) => {
    const child = spawn(pythonPath(), [INGEST, ...args], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL || 'postgresql://karina@localhost:5432/ord_xplore' },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\nTimed out.'; }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function validateXml(content) {
  const errors = [];
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: (e) => errors.push(e), fatalError: (e) => errors.push(e) },
  }).parseFromString(content, 'text/xml');
  if (errors.length) return `The file is not well-formed XML: ${String(errors[0]).slice(0, 200)}`;
  const root = doc.documentElement;
  if (!root || (root.localName !== 'TEI' && root.localName !== 'teiCorpus')) return 'The root element must be <TEI> or <teiCorpus>.';
  if (!doc.getElementsByTagNameNS('http://www.tei-c.org/ns/1.0', 'teiHeader')[0] && !doc.getElementsByTagName('teiHeader')[0]) {
    return 'The <teiHeader> element is missing.';
  }
  return null;
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,POST,OPTIONS')) return;
  const avail = availability();
  if (req.method === 'GET') return res.status(200).json(avail);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!avail.available) return res.status(501).json({ error: avail.reason });

  const { filename, content, edition, mode = 'preview', replace = false, newEdition = null } = req.body || {};
  if (typeof filename !== 'string' || typeof content !== 'string' || typeof edition !== 'string') {
    return res.status(400).json({ error: 'filename, content and edition are required.' });
  }
  if (!EDITION_RE.test(edition)) {
    return res.status(400).json({ error: 'The edition name may only contain letters, digits, "_" and "-".' });
  }
  if (!filename.toLowerCase().endsWith('.xml') || /[\\/]/.test(filename) || filename.startsWith('.')) {
    return res.status(400).json({ error: 'The file must be a .xml file name without folders.' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return res.status(413).json({ error: `The file is larger than ${MAX_CONTENT_BYTES / 1024 / 1024} MB.` });
  }
  const invalid = validateXml(content);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const schema = await ensureSchema();
    if (!schema.hasColumn('documents', 'file_path')) {
      return res.status(409).json({ error: 'This database is the old version (no documents.file_path). Uploads need the v2 database built by data/build/run_phase2.sh.' });
    }
  } catch (e) {
    return res.status(500).json({ error: `Database unavailable: ${e.message}` });
  }

  const rel = `${edition}/${filename}`;
  const args = ['--edition', edition, '--files', rel];
  if (newEdition) args.push('--new-edition', JSON.stringify(newEdition));
  let tmpDir = null, written = null;
  try {
    if (mode === 'preview') {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordx-upload-'));
      fs.mkdirSync(path.join(tmpDir, edition));
      fs.writeFileSync(path.join(tmpDir, rel), content, 'utf8');
      args.push('--raw-dir', tmpDir, '--dry-run');
    } else {
      const target = path.join(RAW_DOCS_ROOT, rel);
      if (!path.resolve(target).startsWith(RAW_DOCS_ROOT + path.sep)) return res.status(400).json({ error: 'Invalid path.' });
      if (fs.existsSync(target) && !replace) {
        return res.status(409).json({ error: `${rel} already exists in raw_documents/. Tick "Replace existing" to overwrite it.`, duplicate: true });
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const existed = fs.existsSync(target);
      fs.writeFileSync(target, content, 'utf8');
      if (!existed) written = target;
      args.push('--raw-dir', RAW_DOCS_ROOT);
      if (replace) args.push('--replace');
    }
    const r = await runIngest(args);
    let data = null;
    try { data = JSON.parse(r.out.trim().split('\n').pop()); } catch (_) { /* reported below */ }
    if (!data || data.error || r.code !== 0) {
      if (written) fs.rmSync(written, { force: true });
      return res.status(500).json({ error: data?.error || `The extraction failed: ${(r.err || r.out).slice(-600)}` });
    }
    const result = data.results[0];
    if (mode === 'preview' && fs.existsSync(path.join(RAW_DOCS_ROOT, rel))) {
      result.warnings = [`${rel} already exists; adding it again needs "Replace documents that already exist".`, ...(result.warnings || [])];
    }
    if (written && result.status !== 'added') fs.rmSync(written, { force: true });
    const status = result.status === 'duplicate' ? 409 : result.status === 'error' ? 422 : 200;
    return res.status(status).json({ ...result, edition: data.edition, editionCreated: data.edition_created });
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
