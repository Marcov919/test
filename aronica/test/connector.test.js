// HTTP-level tests: MCP protocol, REST auth, OpenAPI, tools.json, fail-closed over the wire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARONICA_NEG_DELAY_MS = '0';
process.env.ARONICA_UPLOADS = mkdtempSync(join(tmpdir(), 'aronica-up-'));
const { boot } = await import('../src/server.js');

let server;
let B;
const K = { Authorization: 'Bearer ak_demo_milano', 'Content-Type': 'application/json' };

before(async () => {
  const r = await boot({ dbPath: ':memory:', port: 0, loop: false });
  server = r.server;
  B = `http://127.0.0.1:${r.port}`;
});
after(() => server.close());

const rpc = async (body, headers = K) => {
  const res = await fetch(`${B}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: res.status === 202 ? null : await res.json(), headers: res.headers };
};

test('MCP initialize / tools/list / notifications', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.ok(init.json.result.capabilities.tools);
  assert.ok(init.headers.get('mcp-session-id'));
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.json.result.tools.map((t) => t.name);
  for (const n of ['list_skills', 'search_workers', 'create_job', 'negotiate', 'auto_negotiate', 'accept_quote', 'get_job', 'wait_for_update', 'cancel_job', 'rate_worker']) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(list.json.result.tools.every((t) => t.inputSchema?.type === 'object'));
  const bad = await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(bad.json.error.code, -32601);
});

test('MCP tools/call requires auth and runs the whole negotiation', async () => {
  const unauth = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_skills', arguments: {} } }, { 'Content-Type': 'application/json' });
  assert.equal(unauth.json.error.code, -32001);

  const call = async (name, args) => (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })).json.result;
  const skills = await call('list_skills', {});
  assert.equal(skills.isError, false);
  assert.ok(skills.structuredContent.skills.find((s) => s.code === 'shelf_check'));

  const denied = await call('create_job', { title: 'Find me a dentist', location: { address: 'Duomo' } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.message, 'Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta.');

  const created = await call('create_job', { title: 'Shelf check Barilla pesto', location: { address: 'Duomo' }, budget: { target_eur: 14, max_eur: 25 } });
  assert.equal(created.isError, false);
  const jobId = created.structuredContent.job.id;
  const neg = await call('auto_negotiate', { job_id: jobId });
  assert.ok(neg.structuredContent.deal);
  assert.match(neg.structuredContent.confirm_url, /\/buyer#\/job\/job_/);
  const got = await call('get_job', { job_id: jobId, include_events: true });
  assert.equal(got.structuredContent.status, 'pending_confirmation');
  assert.ok(got.structuredContent.events.some((e) => e.type === 'negotiation.deal'));
});

test('REST: auth, OpenAPI, tools.json, search, human confirm link', async () => {
  assert.equal((await fetch(`${B}/v1/skills`)).status, 401);
  const spec = await (await fetch(`${B}/openapi.json`)).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/v1/jobs'].post);
  const tools = await (await fetch(`${B}/v1/tools.json`)).json();
  assert.ok(tools.tools.every((t) => t.type === 'function' && t.function.name.startsWith('aronica_')));

  const s = await (await fetch(`${B}/v1/workers?skill=shelf_check&address=Duomo`, { headers: K })).json();
  assert.equal(s.workers[0].alias, 'Giulia R.');
  assert.ok(!('phone' in s.workers[0]) && !('token' in s.workers[0]));

  const created = await (await fetch(`${B}/v1/jobs`, { method: 'POST', headers: K, body: JSON.stringify({ title: 'Foto vetrina negozio', location: { address: 'Brera' }, budget: { max_eur: 30 } }) })).json();
  const id = created.job.id;
  const r = await (await fetch(`${B}/v1/jobs/${id}/auto-negotiate`, { method: 'POST', headers: K, body: '{}' })).json();
  const t = new URL(r.confirm_url.replace('#/', '')).searchParams.get('t');
  // wrong token is rejected; right token confirms
  assert.equal((await fetch(`${B}/api/jobs/${id}/confirm?t=nope`, { method: 'POST', body: '{}' })).status, 403);
  const conf = await (await fetch(`${B}/api/jobs/${id}/confirm?t=${t}`, { method: 'POST', body: JSON.stringify({ mode: 'now' }) })).json();
  assert.equal(conf.job.status, 'dispatching');
  const ev = await (await fetch(`${B}/v1/jobs/${id}/events?since_seq=0&timeout_s=0`, { headers: K })).json();
  assert.ok(ev.events.some((e) => e.type === 'dispatch.offer_sent'));
  // other accounts cannot see the job
  const other = await (await fetch(`${B}/api/ops/keys`, { method: 'POST', body: JSON.stringify({ name: 'Other' }) })).json();
  assert.equal((await fetch(`${B}/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${other.api_key}` } })).status, 404);
});
