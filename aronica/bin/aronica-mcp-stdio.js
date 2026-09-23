#!/usr/bin/env node
// stdio ⇄ HTTP bridge so desktop MCP clients (Claude Desktop, Cursor, …) can use
// a running Aronica server. Zero dependencies.
//   ARONICA_URL=http://localhost:8787 ARONICA_API_KEY=ak_demo_milano node bin/aronica-mcp-stdio.js
import { createInterface } from 'node:readline';

const base = (process.env.ARONICA_URL || 'http://localhost:8787').replace(/\/$/, '');
const key = process.env.ARONICA_API_KEY || 'ak_demo_milano';
let session = null;

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    return;
  }
  try {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`,
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify(msg),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (res.status === 202) return; // notification
    const text = await res.text();
    if (text) process.stdout.write(text.trim() + '\n');
  } catch (e) {
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Aronica unreachable at ${base}: ${e.message}` } }) + '\n');
    }
  }
});
