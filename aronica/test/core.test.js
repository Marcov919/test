import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARONICA_NEG_DELAY_MS = '0';
process.env.ARONICA_UPLOADS = mkdtempSync(join(tmpdir(), 'aronica-up-'));

const { openDb, get, update, setSetting, insert } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const { clock, NO_SUPPLY_IT, HttpError } = await import('../src/util.js');
const { createJob } = await import('../src/jobs.js');
const { rankCandidates } = await import('../src/matching.js');
const { negotiateRound, acceptQuote, autoNegotiate, supplierPolicy } = await import('../src/negotiation.js');
const { confirmJob, respondOffer, tick, startJob, arriveJob, submitProof, workerCancel } = await import('../src/dispatch.js');
const { evaluate, enforce } = await import('../src/reliability.js');
const { rateWorker } = await import('../src/jobs.js');
const { classify } = await import('../src/skills.js');

const account = { id: 'acc_demo_agent', name: 'Test Agent' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function freshDb() {
  clock.reset();
  openDb(':memory:');
  seed();
  setSetting('simulate_workers', false);
}

const shelfJob = (extra = {}) => createJob(account, {
  title: 'Is Barilla pesto on shelf?',
  location: { address: 'Corso Vittorio Emanuele' },
  deadline_minutes: 120,
  budget: { target_eur: 14, max_eur: 25 },
  ...extra,
});

async function lockedDeal(extra) {
  const { job } = shelfJob(extra);
  const r = await autoNegotiate(job.id);
  assert.ok(r.deal, 'auto negotiation should reach a deal');
  return job.id;
}

beforeEach(freshDb);

test('classifier maps field-proof tasks and fails closed on lifestyle services', () => {
  assert.equal(classify('Is this shelf real? check the planogram').skill, 'shelf_check');
  assert.equal(classify('photo the store front and the insegna').skill, 'store_photo');
  assert.equal(classify('be there at 12 and wait for the courier').skill, 'presence');
  for (const t of ['Find me a Capoeira teacher', 'book nails', 'I need a dentist near Duomo']) {
    const c = classify(t);
    assert.ok(!c || !c.skill, `${t} should not classify`);
  }
});

test('create_job fails closed with the honest message for unsupported tasks, cities, skills', () => {
  const cases = [
    [{ title: 'Capoeira teacher tonight', location: { address: 'Navigli' } }, 'unsupported_task'],
    [{ title: 'Shelf check', city: 'Roma', location: { lat: 41.9, lng: 12.5 } }, 'unsupported_city'],
    [{ title: 'Nails', skill: 'nails', location: { address: 'Brera' } }, 'unsupported_skill'],
    [{ title: 'Shelf check', location: { lat: 45.7, lng: 9.6 } }, 'outside_service_area'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => createJob(account, input), (e) => e instanceof HttpError && e.code === code && e.message === NO_SUPPLY_IT);
  }
});

test('no available workers → no_supply with honest message', () => {
  update('workers', 'b_rilievi', { online: 0 });
  update('workers', 'b_fotopunto', { online: 0 });
  update('workers', 'w_sara', { online: 0 });
  update('workers', 'w_luca', { online: 0 });
  assert.throws(
    () => createJob(account, { title: 'Sopralluogo appartamento in affitto', location: { address: 'Navigli' } }),
    (e) => e.code === 'no_supply' && e.message === NO_SUPPLY_IT && !!e.extra.job_id,
  );
});

test('ranking: Giulia is the clear #1 near the Duomo; suspended / unverified / offline excluded', () => {
  const { job } = shelfJob();
  const { eligible, excluded } = rankCandidates({ ...job, lat: job.location.lat, lng: job.location.lng, deadline_at: Date.parse(job.deadline_at), budget_max_cents: 2500 });
  assert.equal(eligible[0].worker.id, 'w_giulia');
  assert.ok(eligible[0].score - eligible[1].score > 3);
  const reasons = Object.fromEntries(excluded.map((e) => [e.worker_id, e.reasons]));
  assert.ok(reasons.w_francesca.includes('suspended'));
  assert.ok(reasons.w_chiara.includes('not_verified'));
  assert.ok(reasons.w_paolo.includes('offline'));
  // warning tier ranks below comparable good workers
  const davide = eligible.find((c) => c.worker.id === 'w_davide');
  assert.equal(davide.worker.tier, 'warning');
  assert.ok(davide.score < eligible.find((c) => c.worker.id === 'w_marco').score);
});

test('supplier policy: counters, concedes toward floor, accepts at/above threshold, walks away late', () => {
  const c = { floor_cents: 1500, breakdown: { rating: 1 }, worker: { display_name: 'X', vehicle: 'bike' }, distance_km: 1, eta_min: 5 };
  const skill = { name_it: 'Verifica scaffale' };
  const r1 = supplierPolicy(c, skill, 1000, 1, null);
  assert.equal(r1.action, 'counter');
  assert.ok(r1.price_cents > 1500);
  const r2 = supplierPolicy(c, skill, 1200, 2, r1.price_cents);
  assert.equal(r2.action, 'counter');
  assert.ok(r2.price_cents < r1.price_cents && r2.price_cents >= 1500);
  assert.equal(supplierPolicy(c, skill, 1500, 3, r2.price_cents).action, 'accept');
  assert.equal(supplierPolicy(c, skill, 1000, 6, 1500).action, 'reject');
});

test('negotiation is persisted on the job and deal pool is ranked by score', async () => {
  const { job } = shelfJob();
  const r1 = await negotiateRound(job.id, 1200);
  assert.equal(r1.round, 1);
  assert.equal(r1.responses.length, 5);
  assert.ok(r1.responses.every((r) => r.action === 'counter'));
  const r2 = await negotiateRound(job.id, 2100);
  assert.ok(r2.best_accept);
  const deal = acceptQuote(job.id, r2.best_accept.quote_id);
  assert.equal(deal.price_cents, 2100);
  assert.equal(deal.lead.worker_ref, 'w_giulia');
  const stored = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(stored.status, 'pending_confirmation');
  assert.equal(stored.deal.price_cents, 2100);
  assert.ok(get('SELECT COUNT(*) AS c FROM quotes WHERE job_id = ?', job.id).c >= 10);
  await assert.rejects(negotiateRound(job.id, 2000), (e) => e.code === 'not_negotiating');
});

test('built-in buyer agent stays within max and lands the top-ranked worker', async () => {
  const id = await lockedDeal();
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.ok(job.deal.price_cents <= 2500);
  assert.equal(job.deal.pool[0], 'w_giulia');
});

test('confirm → offer to #1 → accept claims the job and cancels the rest', async () => {
  const id = await lockedDeal();
  confirmJob(id, { mode: 'now' });
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(job.status, 'dispatching');
  assert.equal(job.escrow.status, 'held');
  const offer = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", id);
  assert.equal(offer.worker_id, 'w_giulia');
  assert.equal(offer.rank, 1);
  respondOffer('w_giulia', offer.id, true);
  const after = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(after.status, 'assigned');
  assert.equal(after.assigned_worker_id, 'w_giulia');
  assert.equal(get("SELECT COUNT(*) AS c FROM offers WHERE job_id = ? AND status = 'pending'", id).c, 0);
  assert.throws(() => respondOffer('w_giulia', offer.id, true), (e) => e.code === 'offer_not_pending');
});

test('cascade: expired and declined offers move to the next worker; exhausted pool → no_match honestly', async () => {
  const id = await lockedDeal();
  confirmJob(id, { mode: 'now' });
  const pool = get('SELECT dispatch_pool FROM jobs WHERE id = ?', id).dispatch_pool;
  assert.ok(pool.length >= 2);
  // #1 ignores it: TTL passes, the loop expires it and offers #2
  clock.freeze(Date.now());
  clock.advance(21_000);
  tick();
  const offers = () => get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", id);
  assert.equal(get("SELECT status FROM offers WHERE job_id = ? AND worker_id = 'w_giulia'", id).status, 'expired');
  assert.equal(offers().worker_id, pool[1]);
  assert.equal(offers().rank, 2);
  // everyone else declines
  let o;
  while ((o = offers())) respondOffer(o.worker_id, o.id, false);
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(job.status, 'no_match');
  assert.equal(job.status_message, NO_SUPPLY_IT);
  assert.equal(job.escrow.status, 'refunded');
  const g = get("SELECT * FROM workers WHERE id = 'w_giulia'");
  assert.equal(g.offers_expired, 1 + Math.round((340 - 327) * 0.4));
});

test('schedule mode assigns ahead of time and extends the deadline window', async () => {
  const id = await lockedDeal();
  const at = new Date(Date.now() + 4 * 3600_000).toISOString();
  confirmJob(id, { mode: 'schedule', scheduled_at: at });
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(job.mode, 'schedule');
  assert.ok(job.deadline_at > Date.parse(at));
  const offer = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", id);
  respondOffer(offer.worker_id, offer.id, true);
  assert.equal(get('SELECT status FROM jobs WHERE id = ?', id).status, 'assigned');
});

test('proof is validated (photos, GPS geofence, checklist) before Done; escrow released', async () => {
  const id = await lockedDeal();
  confirmJob(id, { mode: 'now' });
  const offer = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", id);
  respondOffer('w_giulia', offer.id, true);
  startJob('w_giulia', id);
  assert.throws(() => arriveJob('w_giulia', id), (e) => e.code === 'not_on_site');
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  update('workers', 'w_giulia', { lat: job.lat + 0.0003, lng: job.lng });
  arriveJob('w_giulia', id);
  assert.throws(() => submitProof('w_giulia', id, { photos: [PNG], answers: {} }), (e) => e.code === 'proof_rejected' && e.extra.problems.length >= 2);
  const r = submitProof('w_giulia', id, { photos: [PNG, PNG, PNG], answers: { on_shelf: 'yes', facings: '4' } });
  assert.equal(r.proof.photos.length, 3);
  const done = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(done.status, 'done');
  assert.equal(done.escrow.status, 'released');
  assert.equal(done.proof.answers.facings, 4);
  const res = rateWorker(id, { stars: 5, tags: ['foto_nitide'] });
  assert.equal(res.stars, 5);
  assert.throws(() => rateWorker(id, { stars: 4 }), (e) => e.code === 'already_rated');
});

test('worker cancel after accepting re-enters the cascade and counts against them', async () => {
  const id = await lockedDeal();
  confirmJob(id, { mode: 'now' });
  const offer = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", id);
  respondOffer('w_giulia', offer.id, true);
  workerCancel('w_giulia', id);
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(job.status, 'dispatching');
  const next = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", id);
  assert.notEqual(next.worker_id, 'w_giulia');
  assert.equal(get("SELECT jobs_cancelled FROM workers WHERE id = 'w_giulia'").jobs_cancelled, 3);
});

test('reliability: seed tiers, excluded ratings, warning → suspension', () => {
  assert.equal(get("SELECT tier FROM workers WHERE id = 'w_giulia'").tier, 'good');
  assert.equal(get("SELECT tier FROM workers WHERE id = 'w_davide'").tier, 'warning');
  const f = get("SELECT * FROM workers WHERE id = 'w_francesca'");
  assert.equal(f.status, 'suspended');
  assert.equal(f.online, 0);
  // new worker: 3 ratings is not enough to be judged on rating
  assert.equal(evaluate(get("SELECT * FROM workers WHERE id = 'w_elena'")).tier, 'good');
  // Tommaso gets a streak of 1-star reviews → warning then suspension
  for (let i = 0; i < 40; i++) {
    insert('ratings', { id: `bad_${i}`, job_id: `j${i}`, worker_id: 'w_tommaso', stars: 1, tags: [], excluded: 0, created_at: Date.now() + i });
  }
  enforce('w_tommaso');
  const t = get("SELECT * FROM workers WHERE id = 'w_tommaso'");
  assert.equal(t.status, 'suspended');
  assert.ok(t.tier_reasons[0].includes('Valutazione'));
  // excluded ratings do not count
  for (let i = 0; i < 40; i++) {
    insert('ratings', { id: `ex_${i}`, job_id: `k${i}`, worker_id: 'w_marco', stars: 1, tags: ['luogo_chiuso_o_inaccessibile'], excluded: 1, created_at: Date.now() + i });
  }
  assert.equal(enforce('w_marco').tier, 'good');
});

test('deadline passing on an assigned job → expired, refund, no-show recorded', async () => {
  const id = await lockedDeal();
  confirmJob(id, { mode: 'now' });
  const offer = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", id);
  respondOffer('w_giulia', offer.id, true);
  clock.freeze(Date.now());
  clock.advance(3 * 3600_000);
  tick();
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(job.status, 'expired');
  assert.equal(job.escrow.status, 'refunded');
  assert.equal(get("SELECT no_shows FROM workers WHERE id = 'w_giulia'").no_shows, 1);
});
