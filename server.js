// Development-only static server. No task data, API, database, or dependencies.
// 預設只給本機（127.0.0.1）使用；要讓同 Wi-Fi 手機測試，執行 npm run dev:lan（或設定 LAN=1）。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 5173);
const lan = process.argv.includes('--lan') || process.env.LAN === '1';
const host = lan ? '0.0.0.0' : '127.0.0.1';
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['google-app', 'google-calendar', 'time-parser', 'planner', 'speech-input'].map(name => [`/js/${name}.js`, [`js/${name}.js`, 'text/javascript; charset=utf-8']]),
]);

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  let route;
  try { route = routes.get(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  if (!route) { response.writeHead(404).end('Not found'); return; }
  try {
    const body = await readFile(resolve(root, route[0]));
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(500).end('Unable to read file'); }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set another PORT and restart.` : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`voice-task-reminder: http://localhost:${port}`);
  if (lan) {
    console.log('LAN mode: other devices on the same Wi-Fi can open this page.');
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) console.log(`Same Wi-Fi: http://${entry.address}:${port}`);
      }
    }
  } else {
    console.log('Only this computer can open it. For phone testing on the same Wi-Fi: npm run dev:lan');
  }
  console.log('Press Ctrl+C to stop.');
});
