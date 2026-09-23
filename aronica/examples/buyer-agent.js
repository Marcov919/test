#!/usr/bin/env node
// A scripted buyer agent that exercises the full Agent Connector over REST.
// No LLM needed: it plays the role Claude/Grok/OpenAI would play.
//   ARONICA_URL=http://localhost:8787 node examples/buyer-agent.js [--confirm]
// --confirm taps the human confirm link itself (demo only: normally a person does it).
const B = (process.env.ARONICA_URL || 'http://localhost:8787').replace(/\/$/, '');
const KEY = process.env.ARONICA_API_KEY || 'ak_demo_milano';
const autoConfirm = process.argv.includes('--confirm');

async function call(method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) { const e = new Error(data.message); e.data = data; throw e; }
  return data;
}
const eur = (c) => `€${(c / 100).toFixed(2)}`;

// 1. Out-of-scope request fails closed
try {
  await call('POST', '/v1/jobs', { title: 'Find me a Capoeira teacher near Navigli tonight', location: { address: 'Navigli' } });
} catch (e) {
  console.log(`✗ capoeira → ${e.data.error}: ${e.data.message}`);
}

// 2. Supply check
const s = await call('GET', '/v1/workers?skill=shelf_check&address=Corso%20Vittorio%20Emanuele&limit=3');
console.log(`✓ ${s.available} verified workers available; top: ${s.workers.map((w) => `${w.alias} (score ${w.score}, ${w.eta_min} min)`).join(', ')}`);

// 3. Create the job
const created = await call('POST', '/v1/jobs', {
  title: 'Is Barilla Pesto alla Genovese 190g on shelf?',
  location: { address: 'Esselunga, Corso Vittorio Emanuele' },
  deadline_minutes: 120,
  instructions: ['Go to the ready-sauces aisle', 'Photograph the full pesto bay', 'Close-up of the Barilla 190g price tag', 'Count visible facings'],
  budget: { target_eur: 13, max_eur: 22 },
  agent_name: 'Scripted Buyer Agent',
});
const jobId = created.job.id;
console.log(`✓ job ${jobId} (${created.job.skill}) · ${created.match.eligible_workers} eligible`);

// 4. Negotiate: open low, concede toward the lowest counter
let offer = 1300;
let deal = null;
for (let round = 1; round <= 6 && !deal; round++) {
  const r = await call('POST', `/v1/jobs/${jobId}/negotiate`, { offer_eur: offer / 100 });
  for (const q of r.responses) console.log(`   r${r.round} ${q.alias.padEnd(14)} ${q.action.padEnd(7)} ${eur(q.price_cents)}  ${q.eta_min} min`);
  if (r.best_accept) {
    deal = await call('POST', `/v1/jobs/${jobId}/accept-quote`, { quote_id: r.best_accept.quote_id });
  } else {
    const low = r.lowest_counter.price_cents;
    offer = Math.min(2200, Math.round((offer + (low - offer) * 0.6) / 50) * 50);
  }
}
console.log(`✓ deal ${eur(deal.job.deal.price_cents)} · best match ${deal.job.deal.lead.alias} · ${deal.job.deal.eta_min} min`);
console.log(`→ human confirm link: ${deal.confirm_url}`);

if (autoConfirm) {
  const u = new URL(deal.confirm_url.replace('#/job/', 'job/'));
  const t = u.searchParams.get('t');
  await fetch(`${B}/api/jobs/${jobId}/confirm?t=${t}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"now"}' });
  console.log('✓ confirmed (demo auto-confirm)');
}

// 5. Follow the job
let since = 0;
for (;;) {
  const u = await call('GET', `/v1/jobs/${jobId}/events?since_seq=${since}&timeout_s=20`);
  for (const e of u.events) if (!e.type.startsWith('negotiation.')) console.log(`   · ${e.type}${e.data?.alias ? ` (${e.data.alias})` : ''}`);
  since = u.next_since_seq;
  if (['done', 'no_match', 'expired', 'cancelled'].includes(u.status)) break;
}
const job = await call('GET', `/v1/jobs/${jobId}`);
console.log(`✓ ${job.status}: ${job.status_message ?? ''}`);
if (job.proof) {
  console.log(`   proof: ${job.proof.photos.length} photos, GPS ${job.proof.gps.distance_m} m, answers ${JSON.stringify(job.proof.answers)}`);
  await call('POST', `/v1/jobs/${jobId}/rating`, { stars: 5, tags: ['foto_nitide', 'puntuale'] });
  console.log('✓ rated 5★');
}
