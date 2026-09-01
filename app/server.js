import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import API handlers
import dashboardHandler from './api/dashboard.js';
import uploadHandler from './api/upload.js';
import interpretHandler from './api/interpret.js';
import tagsHandler from './api/tags.js';
import analyzeHandler from './api/analyze.js';
import manageHandler from './api/manage.js';
import propertiesHandler from './api/properties.js';

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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 IVDA Dynamic SQL Dashboard local server running at:`);
  console.log(`   👉 http://localhost:${PORT}/`);
  console.log(`   👉 http://localhost:${PORT}/upload.html (Document Ingestion Page)\n`);
});
