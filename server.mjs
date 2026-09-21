// Static file server + thin proxy so the API key never reaches the browser.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askJev, listModels, loadApiKey, MODEL } from './jev.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3210;
const API_KEY = loadApiKey();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, hasKey: !!API_KEY, model: MODEL });
    }
    if (url.pathname === '/api/models') {
      if (!API_KEY) return json(res, 503, { error: 'TYPESAFE_API_KEY is not set' });
      return json(res, 200, await listModels(API_KEY));
    }
    if (url.pathname === '/api/next' && req.method === 'POST') {
      if (!API_KEY) return json(res, 503, { error: 'TYPESAFE_API_KEY is not set' });
      const { state } = await readBody(req);
      if (!state || typeof state !== 'object') return json(res, 400, { error: 'state required' });
      const t0 = performance.now();
      const out = await askJev(API_KEY, state);
      return json(res, 200, { ...out, server_ms: Math.round(performance.now() - t0) });
    }
    // static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    const status = err.status && err.status >= 400 ? 502 : 500;
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname} -> ${err.message}`);
    json(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Jev Runner: http://localhost:${PORT}`);
  console.log(
    API_KEY
      ? `TypeSafe key: loaded (model ${MODEL})`
      : 'TypeSafe key: NOT FOUND -> game runs in offline heuristic mode',
  );
});
