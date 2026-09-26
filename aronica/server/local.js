// Local server: `npm start`. Same handler as the Vercel function, plus the
// static apps and a background loop (a local process can keep one).
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleRequest } from './app.js';
import { ensureReady, startLoop, resetReady } from './runtime.js';
import { closeDb } from '../core/db.js';

export async function boot({ db = undefined, port = Number(process.env.PORT || 8787), loop = true } = {}) {
  resetReady();
  const { seeded } = await ensureReady(db);
  const server = http.createServer((req, res) => handleRequest(req, res));
  const stop = loop ? startLoop() : () => {};
  server.on('close', () => { stop(); });
  await new Promise((r) => server.listen(port, r));
  return { server, seeded, port: server.address().port, close: async () => { await new Promise((r) => server.close(r)); await closeDb(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port, seeded } = await boot();
  const base = process.env.ARONICA_PUBLIC_URL || `http://localhost:${port}`;
  const db = (process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : process.env.ARONICA_DB || 'data/aronica.db');
  console.log(`
  Aronica · Milano${seeded ? ' (seeded demo data)' : ''} · DB: ${db}
  ─────────────────────────────────────────────
  Assistente (simulato)  ${base}/assistant
  App partner            ${base}/partner
  Conferma (link)        ${base}/confirm
  Ops                    ${base}/ops
  Connettore agenti      ${base}/docs   ·   MCP ${base}/mcp (Bearer ak_demo_milano)
`);
}
