import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load KEY=value pairs from .env (repo root or app/) for local runs. Vercel
// injects env vars itself, and existing variables are never overwritten.
for (const envPath of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// Import API handlers
import dashboardHandler from './api/dashboard.js';
import uploadHandler from './api/upload.js';
import interpretHandler from './api/interpret.js';
import tagsHandler from './api/tags.js';
import analyzeHandler from './api/analyze.js';
import manageHandler from './api/manage.js';
import propertiesHandler from './api/properties.js';
import documentHandler from './api/document.js';
import infoHandler from './api/info.js';

// Mock request body parser
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Decorate response to match Vercel Serverless Function signature
function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
    return res;
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  decorateResponse(res);

  // Vercel populates req.query from the query string; mirror that locally.
  req.query = Object.fromEntries(url.searchParams);

  // Parse JSON bodies for POST requests
  if (req.method === 'POST') {
    req.body = await parseBody(req);
  }

  // --- API Routes ---
  const API_ROUTES = {
     '/api/dashboard': dashboardHandler,
     '/api/upload': uploadHandler,
     '/api/interpret': interpretHandler,
     '/api/tags': tagsHandler,
     '/api/analyze': analyzeHandler,
     '/api/manage': manageHandler,
     '/api/properties': propertiesHandler,
     '/api/document': documentHandler,
     '/api/info': infoHandler,
  };

  const apiHandler = API_ROUTES[pathname];
  if (apiHandler) {
    try {
      await apiHandler(req, res);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // --- Static Files Routing ---
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.status(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.status(404).end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypeMap = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };

    res.setHeader('Content-Type', contentTypeMap[ext] || 'text/plain');
    fs.createReadStream(filePath).pipe(res);
  });
});

// Parse CLI arguments & Environment variables
const args = process.argv.slice(2);
let portVal = process.env.PORT || 3000;
let modeVal = process.env.ENGINE_MODE || 'llm';

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--port=')) portVal = args[i].split('=')[1];
  else if (args[i] === '--port' && args[i + 1]) portVal = args[++i];
  else if (args[i].startsWith('--mode=')) modeVal = args[i].split('=')[1];
  else if (args[i] === '--mode' && args[i + 1]) modeVal = args[++i];
}

const PORT = parseInt(portVal, 10);
const ENGINE_MODE = modeVal.toLowerCase();
process.env.PORT = String(PORT);
process.env.ENGINE_MODE = ENGINE_MODE;
// Locally, try the CaISI service on its default port (metadata-curation-framework).
process.env.CAISI_URL = process.env.CAISI_URL || 'http://localhost:8001';

server.listen(PORT, () => {
  const modeLabel = ENGINE_MODE === 'llm' ? '✨ CaISI LLM Engine (Google Gemini 3.6 Flash)' : '⚙️ Local Heuristic Engine (Rules & Regex)';
  console.log(`\n🚀 Digital Editions Explorer server running in [${ENGINE_MODE.toUpperCase()}] mode:`);
  console.log(`   👉 http://localhost:${PORT}/ (${modeLabel})`);
  console.log(`   👉 http://localhost:${PORT}/upload.html (Document Ingestion Page)\n`);
});
