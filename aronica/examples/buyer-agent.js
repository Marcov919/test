#!/usr/bin/env node
// Scripted agents that exercise the Agent Connector over REST (no LLM needed):
// they play the role Claude / Grok / OpenAI would play.
//   ARONICA_URL=http://localhost:8787 node examples/buyer-agent.js [--confirm]
// --confirm taps the human confirm link itself (demo only: normally a person does it).
const B = (process.env.ARONICA_URL || 'http://localhost:8787').replace(/\/$/, '');
const autoConfirm = process.argv.includes('--confirm');
const eur = (c) => `€${(c / 100).toFixed(2)}`;

function client(key) {
  return async (method, path, body) => {
    const res = await fetch(B + path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) { const e = new Error(data.message); e.data = data; throw e; }
    return data;
  };
}

async function follow(call, jobId, until) {
  let since = 0;
  for (;;) {
    const u = await call('GET', `/v1/jobs/${jobId}/events?since_seq=${since}&timeout_s=10`);
    for (const e of u.events) if (!e.type.startsWith('negotiation.')) console.log(`   · ${e.type}${e.data?.alias ? ` (${e.data.alias}${e.data.seats > 1 ? ` × ${e.data.seats}` : ''})` : ''}`);
    since = u.next_since_seq;
    if (until(u.status)) return u.status;
  }
}

// 1) Personal assistant: planning the week → gardener on Saturday morning
const me = client('ak_demo_milano');
try { await me('POST', '/v1/jobs', { text: 'Trovami un insegnante di Capoeira ai Navigli' }); } catch (e) { console.log(`✗ capoeira → ${e.data.error}: ${e.data.message}`); }
const c = await me('POST', '/v1/tasks/compile', { text: 'sistemare il giardino sabato mattina, circa 80 mq con la siepe, zona Navigli' });
console.log(`✓ compiled: ${c.service.name} · ${c.window.label} · ${eur(c.price.total_cents)} fixed · open questions: ${c.questions.map((q) => q.key).join(', ') || 'none'}`);
const job = (await me('POST', '/v1/jobs', { text: 'sistemare il giardino sabato mattina, circa 80 mq con la siepe, zona Navigli', agent_name: 'Scripted assistant' })).job;
const neg = await me('POST', `/v1/jobs/${job.id}/negotiate`, {});
for (const r of neg.responses) console.log(`   ${r.alias.padEnd(22)} ${r.action.padEnd(8)} ${r.slot_label ?? ''}`);
const pick = neg.best_accept ?? neg.earliest_counter;
const acc = await me('POST', `/v1/jobs/${job.id}/accept-quote`, { quote_id: pick.quote_id });
console.log(`✓ slot ${acc.job.deal.slot_label} with ${acc.job.deal.lead.alias} → human confirm: ${acc.confirm_url}`);
if (autoConfirm) {
  const t = new URL(acc.confirm_url.replace('#/job/', 'job/')).searchParams.get('t');
  await fetch(`${B}/api/jobs/${job.id}/confirm?t=${t}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log('✓ confirmed (demo auto-confirm)');
  await follow(me, job.id, (s) => ['assigned', 'no_match', 'cancelled'].includes(s));
}

// 2) Company procurement agent: 4 facchini at Fiera Rho, auto-approved by policy
const biz = client('ak_demo_business');
const shift = (await biz('POST', '/v1/jobs', { text: 'Servono 4 facchini venerdì 7-12 alla Fiera di Rho per allestimento stand', agent_name: 'Aurora procurement agent' })).job;
const auto = await biz('POST', `/v1/jobs/${shift.id}/auto-negotiate`, {});
console.log(`✓ ${shift.title}: ${eur(shift.price.total_cents)} · auto-approved: ${auto.auto_approved}`);
const status = await follow(biz, shift.id, (s) => ['assigned', 'no_match', 'cancelled'].includes(s));
const full = await biz('GET', `/v1/jobs/${shift.id}`);
console.log(`✓ ${status}: ${full.seats_filled}/${full.headcount} seats`);
for (const a of full.assignments) console.log(`   ${a.worker.alias.padEnd(24)} crew ${a.crew} · ${a.contract.label}`);
