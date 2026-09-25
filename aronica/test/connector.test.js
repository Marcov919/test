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
const hdr = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
const K = hdr('ak_demo_milano');
const KB = hdr('ak_demo_business');

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
const call = async (name, args, headers = K) => (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, headers)).json.result;

test('MCP initialize / tools/list / notifications', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.ok(init.headers.get('mcp-session-id'));
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const names = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools.map((t) => t.name);
  for (const n of ['list_services', 'compile_task', 'search_supply', 'create_job', 'negotiate', 'auto_negotiate', 'accept_quote', 'get_job', 'wait_for_update', 'cancel_job', 'rate_worker']) assert.ok(names.includes(n), n);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' })).json.error.code, -32601);
});

test('MCP: personal assistant plans the week → gardener, human confirm link', async () => {
  const unauth = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_services', arguments: {} } }, { 'Content-Type': 'application/json' });
  assert.equal(unauth.json.error.code, -32001);
  const compiled = await call('compile_task', { text: 'sistemare il giardino sabato mattina, circa 80 mq con la siepe, zona Navigli' });
  assert.equal(compiled.isError, false);
  assert.equal(compiled.structuredContent.service.code, 'giardinaggio');
  const denied = await call('create_job', { text: 'trovami un dentista vicino al Duomo' });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.message, 'Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta.');
  const created = await call('create_job', { text: 'sistemare il giardino sabato mattina, circa 80 mq con la siepe, zona Navigli' });
  assert.equal(created.isError, false, JSON.stringify(created.structuredContent));
  const jobId = created.structuredContent.job.id;
  const neg = await call('auto_negotiate', { job_id: jobId });
  assert.ok(neg.structuredContent.deal || neg.structuredContent.counters.length);
  if (neg.structuredContent.deal) {
    assert.equal(neg.structuredContent.auto_approved, false);
    assert.match(neg.structuredContent.confirm_url, /\/buyer#\/job\/job_/);
  }
});

test('MCP: company agent books 4 facchini at Fiera Rho, auto-approved and dispatched', async () => {
  const created = await call('create_job', { text: '4 facchini venerdì 7-12 alla Fiera di Rho per allestimento stand' }, KB);
  assert.equal(created.isError, false, JSON.stringify(created.structuredContent));
  const jobId = created.structuredContent.job.id;
  const neg = await call('auto_negotiate', { job_id: jobId }, KB);
  assert.equal(neg.structuredContent.auto_approved, true);
  assert.equal(neg.structuredContent.job.status, 'dispatching');
  const ev = await call('wait_for_update', { job_id: jobId, since_seq: 0, timeout_s: 0 }, KB);
  assert.ok(ev.structuredContent.events.some((e) => e.type === 'dispatch.offer_sent'));
  // other accounts cannot see it
  const other = await call('get_job', { job_id: jobId }, K);
  assert.equal(other.isError, true);
});

test('REST: auth, OpenAPI, tools.json, compile, supply, human confirm link', async () => {
  assert.equal((await fetch(`${B}/v1/services`)).status, 401);
  const spec = await (await fetch(`${B}/openapi.json`)).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/v1/tasks/compile'].post);
  const tools = await (await fetch(`${B}/v1/tools.json`)).json();
  assert.ok(tools.tools.every((t) => t.type === 'function' && t.function.name.startsWith('aronica_')));
  const sup = await (await fetch(`${B}/v1/supply?service=montaggio_mobili&address=Brera`, { headers: K })).json();
  assert.ok(sup.available >= 1);
  assert.ok(!('token' in sup.partners[0]));

  const created = await (await fetch(`${B}/v1/jobs`, { method: 'POST', headers: K, body: JSON.stringify({ text: 'montare 3 mobili ikea giovedì', location: { address: 'Brera' } }) })).json();
  const id = created.job.id;
  const r = await (await fetch(`${B}/v1/jobs/${id}/auto-negotiate`, { method: 'POST', headers: K, body: '{}' })).json();
  assert.ok(r.confirm_url);
  const t = new URL(r.confirm_url.replace('#/', '')).searchParams.get('t');
  assert.equal((await fetch(`${B}/api/jobs/${id}/confirm?t=nope`, { method: 'POST', body: '{}' })).status, 403);
  const conf = await (await fetch(`${B}/api/jobs/${id}/confirm?t=${t}`, { method: 'POST', body: '{}' })).json();
  assert.equal(conf.job.status, 'dispatching');
});
