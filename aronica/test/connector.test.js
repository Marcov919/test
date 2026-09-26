// HTTP-level tests: MCP protocol, REST auth, OpenAPI, tools.json, fail-closed over the wire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ARONICA_NEG_DELAY_MS = '0';
const { boot } = await import('../server/local.js');

let app;
let B;
const hdr = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
const K = hdr('ak_demo_milano');
const KB = hdr('ak_demo_business');

before(async () => {
  app = await boot({ db: process.env.ARONICA_TEST_DB ?? ':memory:', port: 0, loop: false });
  B = `http://127.0.0.1:${app.port}`;
});
after(() => app.close());

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

test('MCP: personal assistant books a car wash (compile → supply → negotiate), human confirm link', async () => {
  const unauth = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_services', arguments: {} } }, { 'Content-Type': 'application/json' });
  assert.equal(unauth.json.error.code, -32001);
  const text = 'Porta la mia auto all\'autolavaggio sabato mattina e riportamela — Navigli, berlina, interno+esterno.';
  const compiled = await call('compile_task', { text });
  assert.equal(compiled.isError, false);
  assert.equal(compiled.structuredContent.service.code, 'lavaggio_auto');
  const supply = await call('search_supply', { text, limit: 3 });
  assert.equal(supply.structuredContent.partners[0].alias, 'Wash&Go Navigli Snc');
  const denied = await call('create_job', { text: 'Trovami un insegnante di Capoeira ai Navigli' });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.message, 'Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta.');
  assert.equal(denied.structuredContent.reason, 'fuori ambito v1');
  const created = await call('create_job', { text });
  assert.equal(created.isError, false, JSON.stringify(created.structuredContent));
  const neg = await call('auto_negotiate', { job_id: created.structuredContent.job.id });
  assert.equal(neg.structuredContent.auto_approved, false);
  assert.match(neg.structuredContent.confirm_url, /\/confirm\/#\/job\/job_/);
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
