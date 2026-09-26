import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARONICA_NEG_DELAY_MS = '0';
process.env.ARONICA_UPLOADS = mkdtempSync(join(tmpdir(), 'aronica-up-'));

const { openDb, get, all, update, setSetting, insert } = await import('../src/db.js');
const { seed, CONSOLE_ACCOUNT, CONSOLE_BUSINESS_ACCOUNT } = await import('../src/seed.js');
const { clock, NO_SUPPLY_IT, HttpError } = await import('../src/util.js');
const { compileTask, classify } = await import('../src/compiler.js');
const { createJob, rateWorker, serializeJob } = await import('../src/jobs.js');
const { searchSupply } = await import('../src/connector.js');
const { negotiateRound, acceptQuote, autoNegotiate } = await import('../src/negotiation.js');
const { confirmJob, respondOffer, tick, startJob, arriveJob, submitProof, workerCancel, markNoShow } = await import('../src/dispatch.js');
const { evaluate, enforce } = await import('../src/reliability.js');
const { romeParts, romeTime } = await import('../src/time.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const consumer = () => get('SELECT * FROM accounts WHERE id = ?', CONSOLE_ACCOUNT);
const business = () => get('SELECT * FROM accounts WHERE id = ?', CONSOLE_BUSINESS_ACCOUNT);

// Next weekday (Rome) at hh:mm, at least 2 days ahead so no short-notice surcharge.
function nextDow(dow, h, m = 0) {
  const p = romeParts(clock.now());
  let add = ((dow - p.dow + 7) % 7) || 7;
  if (add < 2) add += 7;
  return romeTime(p.y, p.m, p.d + add, h, m);
}
const iso = (ms) => new Date(ms).toISOString();

beforeEach(() => {
  clock.reset();
  openDb(':memory:');
  seed();
  setSetting('simulate_workers', false);
});

function moveTo(workerId, job) { update('workers', workerId, { lat: job.lat + 0.0002, lng: job.lng }); }

// ---------------------------------------------------------------- compiler
test('compiler: vague home request → structured, priced job with open questions', () => {
  const c = compileTask({ text: 'devo sistemare il giardino sabato mattina, sono circa 80 mq con la siepe, zona Navigli' });
  assert.equal(c.service.code, 'giardinaggio');
  assert.equal(c.params.area_m2, 80);
  assert.equal(c.params.siepi, true);
  assert.equal(romeParts(Date.parse(c.window.start)).dow, 6);
  assert.equal(romeParts(Date.parse(c.window.start)).h, 8);
  assert.equal(c.window.flexible, true);
  assert.equal(c.location.address, 'Navigli');
  assert.ok(c.price.total_cents > 5000);
  assert.ok(c.price.lines.some((l) => l.label === 'Siepi'));
  assert.equal(c.ready, true);
});

test('compiler: business shift → headcount, exact window, per-person pricing', () => {
  const c = compileTask({ text: 'Servono 4 facchini venerdì 7-12 alla Fiera di Rho per allestimento stand' });
  assert.equal(c.service.code, 'facchinaggio_allestimento');
  assert.equal(c.headcount, 4);
  assert.equal(c.duration_min, 300);
  assert.equal(c.window.flexible, false);
  assert.equal(romeParts(Date.parse(c.window.start)).h, 7);
  assert.equal(c.location.address, 'Fiera Milano Rho');
  assert.equal(c.price.seats, 4);
  assert.equal(c.price.seat_payout_cents * 4 <= c.price.payout_total_cents, true);
});

test('compiler: errands need a spending cap; out-of-scope fails closed', () => {
  const c = compileTask({ text: 'comprarmi un jeans 501 taglia 32 da Levi\'s in Corso Vittorio Emanuele entro le 19, max 120 euro' });
  assert.equal(c.service.code, 'commissione_acquisto');
  assert.equal(c.params.spesa_max_eur, 120);
  assert.match(c.params.articolo, /jeans/);
  assert.equal(c.price.hold_cents, 12000);
  const noCap = compileTask({ text: 'comprami un regalo in Brera domani' });
  assert.equal(noCap.ready, false);
  assert.ok(noCap.questions.some((q) => q.key === 'spesa_max_eur' && q.blocking));
  for (const t of ['Trovami un insegnante di Capoeira ai Navigli', 'prenota le unghie', 'mi serve un idraulico per la caldaia']) {
    assert.throws(() => compileTask({ text: t }), (e) => e instanceof HttpError && e.message === NO_SUPPLY_IT && e.code === 'unsupported_task');
  }
  // …but waiting at home FOR the plumber is in scope
  assert.equal(classify('aspettare l\'idraulico a casa domani 9-13').service.code, 'attesa_in_casa');
});

test('pricing: fixed price with explicit short-notice surcharge', () => {
  const soon = compileTask({ service: 'montaggio_mobili', params: { pezzi: 2 }, location: { address: 'Brera' }, window: { start: iso(clock.now() + 2 * 3600000), end: iso(clock.now() + 6 * 3600000) } });
  const later = compileTask({ service: 'montaggio_mobili', params: { pezzi: 2 }, location: { address: 'Brera' }, window: { start: iso(nextDow(3, 9)), end: iso(nextDow(3, 18)) } });
  assert.ok(soon.price.surcharges.some((s) => s.pct === 30));
  assert.equal(later.price.surcharges.length, 0);
  assert.ok(soon.price.total_cents > later.price.total_cents);
});

// ---------------------------------------------------------------- consumer flow
const HERO = 'Porta la mia auto all\'autolavaggio sabato mattina e riportamela — Navigli, berlina, interno+esterno.';

test('hero: car wash sentence compiles to a structured, fixed-price job', () => {
  const c = compileTask({ text: HERO });
  assert.equal(c.service.code, 'lavaggio_auto');
  assert.deepEqual(c.params, { veicolo: 'berlina', tipo: 'interno_esterno', ritiro: true });
  assert.equal(c.location.address, 'Navigli');
  assert.equal(romeParts(Date.parse(c.window.start)).dow, 6);
  assert.equal(romeParts(Date.parse(c.window.start)).h >= 8, true);
  assert.equal(c.price.total_cents, 5800);
  assert.equal(c.proof.photos_min, 4);
  assert.deepEqual(c.proof.shots, ['Targa', 'Auto prima', 'Auto dopo', 'Interni / riconsegna']);
  assert.equal(c.questions.length, 0);
});

test('hero: search_supply ranks local car-wash partners, Wash&Go first, with how they do it', () => {
  const s = searchSupply({ text: HERO });
  assert.ok(s.available >= 3);
  assert.equal(s.partners[0].worker_ref, 'b_washgo');
  assert.ok(s.partners.some((p) => p.worker_ref === 'w_luca' && /carrello mobile/.test(p.how)));
  assert.deepEqual(Object.keys(s.partners[0].score_breakdown), ['proximity', 'rating', 'reliability', 'service_fit', 'acceptance']);
});

test('hero: car wash → A2A slot → human confirm → offer to Wash&Go → decline cascades to the next partner', async () => {
  const { job } = createJob(consumer(), { text: HERO });
  const round = await negotiateRound(job.id);
  assert.equal(round.best_accept.worker_ref, 'b_washgo');
  assert.equal(acceptQuote(job.id, round.best_accept.quote_id).auto_approved, false);
  confirmJob(job.id, { by: 'human' });
  const first = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  assert.equal(first.worker_id, 'b_washgo');
  respondOffer('b_washgo', first.id, false);
  const second = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  assert.ok(second && second.worker_id !== 'b_washgo', 'cascade to the next partner');
  const res = respondOffer(second.worker_id, second.id, true);
  assert.match(res.contract, /P\.IVA|occasionale/);
  const j = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(j.status, 'assigned');
  assert.equal(serializeJob(j).assignments[0].worker.how != null, true);
});

test('fail closed: Capoeira has a reason and never reaches a partner; errands beyond 3 km are refused', () => {
  assert.throws(() => compileTask({ text: 'Trovami un insegnante di Capoeira ai Navigli per stasera' }), (e) => e.message === NO_SUPPLY_IT && e.extra.reason === 'fuori ambito v1');
  assert.throws(() => createJob(consumer(), { text: 'Trovami un insegnante di Capoeira ai Navigli' }), (e) => e.extra.reason === 'fuori ambito v1');
  assert.equal(get('SELECT COUNT(*) AS c FROM offers').c, 0);
  assert.throws(() => compileTask({ text: 'Ritira le chiavi in portineria in Via Padova e portamele, sono in zona Navigli' }), (e) => e.code === 'outside_errand_radius' && e.message === NO_SUPPLY_IT);
  const ok = compileTask({ text: 'Ritira un farmaco alla Farmacia di Porta Ticinese e portamelo a casa entro le 19, zona Navigli' });
  assert.equal(ok.service.code, 'ritiro_consegna');
  assert.equal(ok.params.cosa, 'farmaco');
});

test('Adesso vs Programma: "now" is a 3h ASAP window with the short-notice surcharge', () => {
  const now = compileTask({ text: HERO, mode: 'now' });
  const later = compileTask({ text: HERO });
  assert.equal(now.mode, 'now');
  assert.equal(later.mode, 'scheduled');
  assert.ok(now.price.surcharges.some((x) => x.pct === 30));
  assert.ok(Date.parse(now.window.end) - Date.parse(now.window.start) <= 3 * 3600000);
});

test('consumer: gardener Saturday → A2A slot negotiation → human confirm → offer to the best partner', async () => {
  const { job } = createJob(consumer(), { text: 'sistemare il giardino 80 mq con siepe', location: { address: 'Navigli' }, window: { start: iso(nextDow(6, 8)), end: iso(nextDow(6, 13)) } });
  const round = await negotiateRound(job.id);
  const verde = round.responses.find((r) => r.worker_ref === 'b_verde');
  assert.equal(verde.action, 'accept');
  assert.ok(round.responses.find((r) => r.worker_ref === 'w_paolo'), 'weekend-only gardener is asked too');
  acceptQuote(job.id, round.best_accept.quote_id);
  confirmJob(job.id, { by: 'human' });
  const offer = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  assert.equal(offer.worker_id, round.best_accept.worker_ref);
  respondOffer(offer.worker_id, offer.id, true);
  assert.equal(get('SELECT status FROM jobs WHERE id = ?', job.id).status, 'assigned');
});

test('consumer: nobody free in the window → supplier agents counter-propose another slot', async () => {
  // Only weekend gardener Paolo + Verde (Mon–Sat). Ask for a Sunday: Verde counters.
  const { job } = createJob(consumer(), { text: 'taglio prato 60 mq', location: { address: 'Bicocca' }, window: { start: iso(nextDow(0, 18)), end: iso(nextDow(0, 20)) } });
  const res = await autoNegotiate(job.id);
  assert.equal(res.deal, null);
  assert.ok(res.counters.length >= 1);
  const c = res.counters[0];
  const r = acceptQuote(job.id, c.quote_id);
  assert.equal(r.deal.slot_start, Date.parse(c.slot_start));
  assert.equal(get('SELECT window_start FROM jobs WHERE id = ?', job.id).window_start, Date.parse(c.slot_start));
});

test('consumer: purchase errand end-to-end with receipt under the cap, escrow releases the reimbursement', async () => {
  const { job } = createJob(consumer(), { text: 'comprarmi un jeans da Levi\'s max 120 euro', location: { address: 'Corso Vittorio Emanuele' }, window: { start: iso(nextDow(2, 10)), end: iso(nextDow(2, 19)) } });
  const res = await autoNegotiate(job.id);
  assert.ok(res.deal);
  confirmJob(job.id);
  const j0 = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(j0.escrow.amount_cents, j0.price.total_cents + 12000);
  const o = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  respondOffer(o.worker_id, o.id, true);
  startJob(o.worker_id, job.id);
  moveTo(o.worker_id, j0);
  arriveJob(o.worker_id, job.id);
  assert.throws(() => submitProof(o.worker_id, job.id, { photos: [PNG, PNG], answers: { bought: 'yes', spesa_eur: 150 } }), (e) => e.code === 'proof_rejected');
  submitProof(o.worker_id, job.id, { photos: [PNG, PNG], answers: { bought: 'yes', spesa_eur: 99.9 } });
  const done = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.escrow.purchase_reimbursed_cents, 9990);
  assert.equal(done.invoice, null); // consumers get a receipt, not an invoice
  assert.equal(rateWorker(job.id, { stars: 5, tags: ['puntuale'] }).stars, 5);
});

// ---------------------------------------------------------------- business flow
test('business: 4 facchini → auto-approved by policy → parallel offers, agency crew covers several seats', async () => {
  const { job } = createJob(business(), { text: '4 facchini per allestimento stand', location: { address: 'Fiera Milano Rho' }, window: { start: iso(nextDow(5, 7)), end: iso(nextDow(5, 12)) } });
  assert.equal(job.headcount, 4);
  const res = await autoNegotiate(job.id);
  assert.ok(res.deal);
  assert.equal(res.auto_approved, true);
  const j = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(j.status, 'dispatching');
  assert.equal(j.approval.by, 'policy');
  const pending = all("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  assert.equal(pending.reduce((a, o) => a + o.seats, 0), 4, 'one timed offer per open seat');
  // accept all pending offers
  for (const o of pending) respondOffer(o.worker_id, o.id, true);
  const after = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(after.seats_filled, 4);
  assert.equal(after.status, 'assigned');
  const as = all('SELECT * FROM assignments WHERE job_id = ?', job.id);
  assert.ok(as.every((a) => a.crew <= 2), 'concentration limit: no supplier covers more than half of a 4-person shift');
  assert.ok(as.some((a) => a.contract.route === 'fattura_b2b') || as.every((a) => a.contract.route === 'presto'));
  assert.ok(as.filter((a) => a.contract.route === 'presto').every((a) => a.contract.checks.length === 4));
});

test('business: above the policy threshold a human must approve', async () => {
  const { job } = createJob(business(), { text: '12 hostess per congresso', location: { address: 'MiCo' }, window: { start: iso(nextDow(4, 8)), end: iso(nextDow(4, 18)) } });
  const res = await autoNegotiate(job.id);
  assert.ok(res.deal);
  assert.equal(res.auto_approved, false);
  assert.equal(get('SELECT status FROM jobs WHERE id = ?', job.id).status, 'pending_confirmation');
});

test('compliance: PrestO caps exceeded → somministrazione via partner agency', async () => {
  // Pre-load Marco with PrestO earnings close to the per-worker cap.
  insert('jobs', { id: 'job_old', account_id: 'acc_other', city: 'milano', service: 'staff_eventi', title: 'old', params: {}, instructions: [], proof_req: { kind: 'timesheet' }, lat: 45.46, lng: 9.19, window_start: clock.now(), window_end: clock.now(), duration_min: 60, headcount: 1, price: {}, status: 'done', confirm_token: 'x', created_at: clock.now(), updated_at: clock.now() });
  insert('assignments', { id: 'as_old', job_id: 'job_old', worker_id: 'w_marco', crew: 1, status: 'done', contract: { route: 'presto' }, payout_cents: 498000, assigned_at: clock.now() });
  const { job } = createJob(business(), { text: '1 steward', service: 'staff_eventi', params: { persone: 1, ruolo: 'steward' }, location: { address: 'Porta Venezia' }, window: { start: iso(nextDow(3, 9)), end: iso(nextDow(3, 13)) } });
  await negotiateRound(job.id);
  const q = get("SELECT * FROM quotes WHERE job_id = ? AND worker_id = 'w_marco' AND action = 'accept'", job.id);
  assert.ok(q, 'Marco available');
  acceptQuote(job.id, q.id);
  if (get('SELECT status FROM jobs WHERE id = ?', job.id).status === 'pending_confirmation') confirmJob(job.id);
  const o = get("SELECT * FROM offers WHERE job_id = ? AND worker_id = 'w_marco' AND status = 'pending'", job.id);
  respondOffer('w_marco', o.id, true);
  const a = get("SELECT * FROM assignments WHERE job_id = ? AND worker_id = 'w_marco'", job.id);
  assert.equal(a.contract.route, 'somministrazione');
  assert.ok(a.contract.checks.some((c) => !c.ok));
});

test('guarantee: no-show is detected and the seat is re-dispatched automatically', async () => {
  const { job } = createJob(business(), { text: '2 steward', service: 'staff_eventi', params: { persone: 2, ruolo: 'steward' }, location: { address: 'MiCo' }, window: { start: iso(nextDow(3, 9)), end: iso(nextDow(3, 13)) } });
  await autoNegotiate(job.id);
  if (get('SELECT status FROM jobs WHERE id = ?', job.id).status === 'pending_confirmation') confirmJob(job.id);
  for (const o of all("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id)) respondOffer(o.worker_id, o.id, true);
  const first = all("SELECT * FROM assignments WHERE job_id = ? AND status = 'assigned'", job.id);
  assert.ok(first.length >= 1);
  const j = get('SELECT * FROM jobs WHERE id = ?', job.id);
  // Jump to 25 minutes after the start: nobody left → no-show → replacement offers go out.
  clock.freeze(Date.now());
  clock.advance(j.slot_start + 25 * 60000 - clock.now());
  tick();
  const ns = all("SELECT * FROM assignments WHERE job_id = ? AND status = 'no_show'", job.id);
  assert.ok(ns.length >= 1);
  const w = get('SELECT no_shows FROM workers WHERE id = ?', ns[0].worker_id);
  assert.ok(w.no_shows >= 1);
  const after = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(after.status, 'dispatching');
  assert.ok(get("SELECT COUNT(*) AS c FROM offers WHERE job_id = ? AND status = 'pending'", job.id).c >= 1);
  assert.ok(get("SELECT COUNT(*) AS c FROM events WHERE job_id = ? AND type = 'dispatch.replacement'", job.id).c >= 1);
});

test('timesheet: check-in / check-out, job done, invoice drafted for the company', async () => {
  const { job } = createJob(business(), { text: '1 hostess', service: 'staff_eventi', params: { persone: 1 }, location: { address: 'MiCo' }, window: { start: iso(nextDow(3, 9)), end: iso(nextDow(3, 13)) } });
  await autoNegotiate(job.id);
  if (get('SELECT status FROM jobs WHERE id = ?', job.id).status === 'pending_confirmation') confirmJob(job.id);
  const o = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  respondOffer(o.worker_id, o.id, true);
  const j = get('SELECT * FROM jobs WHERE id = ?', job.id);
  startJob(o.worker_id, job.id);
  moveTo(o.worker_id, j);
  clock.freeze(j.slot_start - 5 * 60000);
  arriveJob(o.worker_id, job.id);
  clock.freeze(j.slot_start + j.duration_min * 60000);
  submitProof(o.worker_id, job.id, { answers: { notes: 'ok' } });
  const done = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(done.status, 'done');
  const a = get('SELECT * FROM assignments WHERE job_id = ?', job.id);
  assert.equal(a.proof.timesheet.minutes_worked, j.duration_min + 5);
  assert.match(done.invoice.number, /^AR-\d{4}-\d{4}$/);
  assert.equal(done.invoice.iva_cents, Math.round(done.invoice.imponibile_cents * 0.22));
});

test('partial coverage is reported honestly, with a proportional refund', async () => {
  // Offline everyone but two people who do staff_eventi on that day.
  for (const w of all('SELECT id FROM workers')) if (!['w_sara', 'w_nadia'].includes(w.id)) update('workers', w.id, { status: 'suspended' });
  const { job } = createJob(business(), { text: '5 hostess', service: 'staff_eventi', params: { persone: 5 }, location: { address: 'MiCo' }, window: { start: iso(nextDow(3, 9)), end: iso(nextDow(3, 13)) } });
  const r = await autoNegotiate(job.id);
  assert.equal(r.deal.seats_available, 2);
  if (get('SELECT status FROM jobs WHERE id = ?', job.id).status === 'pending_confirmation') confirmJob(job.id);
  for (const o of all("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id)) respondOffer(o.worker_id, o.id, true);
  const j = get('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(j.seats_filled, 2);
  assert.equal(j.status, 'assigned');
  assert.match(j.status_message, /Coperti 2 posti su 5/);
  assert.ok(j.escrow.partial_refund_cents > 0);
});

test('partner cancels after accepting: seat goes back into the cascade, counts against them', async () => {
  const { job } = createJob(consumer(), { text: 'montare 2 mobili ikea', location: { address: 'Brera' }, window: { start: iso(nextDow(2, 9)), end: iso(nextDow(2, 18)) } });
  await autoNegotiate(job.id);
  confirmJob(job.id);
  const o = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  respondOffer(o.worker_id, o.id, true);
  const before = get('SELECT jobs_cancelled FROM workers WHERE id = ?', o.worker_id).jobs_cancelled;
  workerCancel(o.worker_id, job.id);
  assert.equal(get('SELECT jobs_cancelled FROM workers WHERE id = ?', o.worker_id).jobs_cancelled, before + 1);
  assert.equal(get('SELECT status FROM jobs WHERE id = ?', job.id).status, 'dispatching');
  const next = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  assert.ok(next && next.worker_id !== o.worker_id);
});

test('cascade: an unanswered offer expires and moves to the next partner', async () => {
  const { job } = createJob(consumer(), { text: 'montare 1 libreria', location: { address: 'Brera' }, window: { start: iso(nextDow(2, 9)), end: iso(nextDow(2, 18)) } });
  await autoNegotiate(job.id);
  confirmJob(job.id);
  const first = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  clock.freeze(Date.now());
  clock.advance(21000);
  tick();
  assert.equal(get('SELECT status FROM offers WHERE id = ?', first.id).status, 'expired');
  const next = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending'", job.id);
  assert.ok(next && next.rank > first.rank);
});

test('reliability tiers still enforced; suspended partners are never dispatched', () => {
  assert.equal(get("SELECT status FROM workers WHERE id = 'w_francesca'").status, 'suspended');
  assert.equal(get("SELECT tier FROM workers WHERE id = 'w_davide'").tier, 'warning');
  assert.equal(evaluate(get("SELECT * FROM workers WHERE id = 'w_elena'")).tier, 'good');
  for (let i = 0; i < 40; i++) insert('ratings', { id: `bad_${i}`, job_id: `j${i}`, worker_id: 'w_tommaso', stars: 1, tags: [], excluded: 0, created_at: Date.now() + i });
  enforce('w_tommaso');
  assert.equal(get("SELECT status FROM workers WHERE id = 'w_tommaso'").status, 'suspended');
});

test('no supply at all → honest no_supply', () => {
  for (const w of all('SELECT id FROM workers')) update('workers', w.id, { status: 'suspended' });
  assert.throws(() => createJob(consumer(), { text: 'pulizia casa 60 mq', location: { address: 'Brera' }, window: { start: iso(nextDow(2, 9)), end: iso(nextDow(2, 18)) } }),
    (e) => e.code === 'no_supply' && e.message === NO_SUPPLY_IT);
});
