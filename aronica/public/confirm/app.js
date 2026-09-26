// Confirm page (the connector's fallback surface, opened from confirm_url):
// slot agreed by the agents → one tap to confirm → timed offer + cascade live →
// partner on the way → proof → rating. Auth = the per-job token in the link.
import {
  h, mount, api, sse, eur, hhmm, toast, icon, avatar,
  createMap, taskPin, workerPin, lightbox, twoStep, setClockOffset, serverNow,
} from '/shared/common.js';

let panel;
let useHash = true;
let memRoute = '#/';
const MY_JOBS = 'aronica.buyer_jobs';
let cfg;
let map;
let es = null;
let state = null; // { job, quotes, token }
let timers = [];

const loadMine = () => { try { return JSON.parse(localStorage.getItem(MY_JOBS) || '[]'); } catch { return []; } };
const saveMine = (l) => { try { localStorage.setItem(MY_JOBS, JSON.stringify(l.slice(0, 20))); } catch { /* */ } };
const remember = (id, token, title) => saveMine([{ id, token, title, at: Date.now() }, ...loadMine().filter((j) => j.id !== id)]);
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };

export function go(r) {
  if (useHash) location.hash = r;
  else { memRoute = r; route(); }
}
export function openBuyerJob(id, token) { go(`#/job/${id}?t=${token}`); }

async function route() {
  clearTimers();
  es?.close(); es = null;
  const m = /^#\/job\/([^?]+)\?t=(.+)$/.exec(useHash ? location.hash : memRoute);
  if (m) return openJob(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  return renderHome();
}

// ------------------------------------------------------------------ home
// This page is the connector's fallback surface: the assistant hands the human
// a confirm_url (…/confirm/#/job/<id>?t=<token>). Without a job there is
// nothing to show: requests start in the assistant.
function honest(message, detail, reason) {
  return h('div.empty', {}, h('div.ico', {}, icon('info')), h('div', {}, h('b', {}, message),
    reason ? h('div', { style: { marginTop: '6px' } }, h('span.badge.red', {}, reason)) : null,
    detail ? h('div.small.muted', { style: { marginTop: '4px' } }, detail) : null));
}

async function renderHome() {
  map.clear();
  const mine = loadMine();
  mount(panel,
    h('div.b-hero', {}, 'Conferma e segui'),
    h('p.muted.small', {}, 'Questa pagina si apre dal link che ti manda il tuo assistente: prezzo fisso, slot concordato dagli agenti, un tap per confermare, poi segui il lavoro fino alla prova.'),
    h('a.btn.primary.block', { href: '/assistant' }, icon('agent'), ' Apri l\'assistente (demo)'),
    mine.length ? h('div', {}, h('h3', { style: { margin: '12px 0 6px' } }, 'Le tue richieste su questo dispositivo'),
      h('div.list', {}, mine.slice(0, 8).map((j) => h('a.item.clickable', { onclick: () => go(`#/job/${j.id}?t=${j.token}`) },
        icon('list'), h('div.grow.small', {}, j.title, h('div.xs.faint', {}, new Date(j.at).toLocaleString('it-IT'))), icon('chevron'))))) : null,
  );
}

// ------------------------------------------------------------------ job view
async function openJob(id, token) {
  try {
    const r = await api(`/api/jobs/${id}?t=${encodeURIComponent(token)}`);
    state = { job: r.job, quotes: r.quotes, token };
    remember(id, token, r.job.title);
  } catch (e) {
    mount(panel, honest('Link non valido', e.message), h('button.btn.block', { onclick: () => go('#/') }, 'Nuova richiesta'));
    return;
  }
  map.clear();
  map.onPick = null;
  renderJob(true);
  const since = Math.max(0, ...(state.job.events ?? []).map((e) => e.seq ?? 0));
  es = sse(`/api/jobs/${encodeURIComponent(id)}/stream?t=${encodeURIComponent(token)}&since=${since}`, onJobEvent);
}

let refetchT = null;
function refetch() {
  clearTimeout(refetchT);
  refetchT = setTimeout(async () => {
    if (!state) return;
    const r = await api(`/api/jobs/${state.job.id}?t=${encodeURIComponent(state.token)}`);
    const prev = state.job.status;
    state.job = r.job; state.quotes = r.quotes;
    renderJob(prev !== r.job.status);
  }, 150);
}

function onJobEvent(e) {
  if (!state) return;
  if (e.type === 'clock.changed') { setClockOffset(e.data.offset_ms); refetch(); return; }
  if (e.type === 'worker.location') {
    const a = state.job.assignments.find((x) => x.worker.worker_ref === e.worker_id);
    if (a) {
      a.worker.position = { lat: e.data.lat, lng: e.data.lng };
      a.worker.eta_min = e.data.eta_min;
      drawJobMap(true, false);
      const el = panel.querySelector(`[data-eta="${e.worker_id}"]`);
      if (el) el.textContent = `arriva in ${Math.max(1, e.data.eta_min)} min`;
    }
    return;
  }
  state.job.events = [...(state.job.events ?? []), e];
  if (e.type.startsWith('negotiation.') && !['negotiation.deal', 'negotiation.counters'].includes(e.type)) {
    const chat = panel.querySelector('#chat');
    if (chat) { appendChat(chat, e); chat.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    return;
  }
  refetch();
}

const STATUS_CLASS = { done: 'green', no_match: 'red', expired: 'red', cancelled: 'red', pending_confirmation: 'dark', dispatching: 'blue', assigned: 'green', in_progress: 'blue', scheduling: 'blue' };

function renderJob(statusChanged) {
  clearTimers();
  const j = state.job;
  drawJobMap(false, statusChanged);
  const header = h('div', {},
    h('div.row.wrap', { style: { gap: '6px' } }, h('span', { class: `badge ${STATUS_CLASS[j.status] ?? ''}` }, j.status_label), h('span.badge', {}, j.service_name), h('span.xs.faint', { style: { marginLeft: 'auto' } }, j.agent_name)),
    h('h2', { style: { marginTop: '8px' } }, j.title),
    h('div.row.small.muted', { style: { marginTop: '6px' } }, icon('pin'), j.location.address),
    h('div.row.small.muted', {}, icon('calendar'), j.slot?.label ?? j.window.label, j.headcount > 1 ? ` · ${j.headcount} persone` : ''));
  let body;
  switch (j.status) {
    case 'scheduling': body = viewScheduling(j); break;
    case 'pending_confirmation': body = viewConfirm(j); break;
    case 'dispatching': case 'assigned': case 'in_progress': body = viewStaffing(j); break;
    case 'done': body = viewDone(j); break;
    default: body = viewClosed(j);
  }
  mount(panel, header, body);
  if (j.status === 'scheduling') panel.querySelector('#chat')?.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

// ---- A2A transcript (negotiation on WHEN)
function appendChat(chat, e) {
  const d = e.data ?? {};
  if (e.type === 'negotiation.started') {
    chat.append(h('div.sys', {}, `Negoziazione A2A con ${d.participants.length} supplier agent: prezzo fisso, si tratta solo il quando`));
  } else if (e.type === 'negotiation.buyer_offer') {
    if (d.round) chat.append(h('div.sys', {}, `Round ${d.round}`));
    chat.append(h('div.msg.me', {}, h('div.avatar', { style: { background: '#000' } }, icon('agent')),
      h('div.bubble', {}, h('div.who', {}, `${e.actor} · buyer agent`), d.message)));
  } else if (e.type === 'negotiation.supplier_response') {
    const badge = d.action === 'accept' ? h('span.badge.green', {}, d.seats > 1 ? `Disponibile · ${d.seats} posti` : 'Disponibile')
      : d.action === 'counter' ? h('span.badge.warn', {}, 'Propone altro orario') : h('span.badge.red', {}, 'Non disponibile');
    chat.append(h('div.msg', {},
      h('div.avatar', { class: d.kind === 'business' ? 'sq' : '', style: { background: '#545454' } }, d.alias.split(' ').map((p) => p[0]).join('').slice(0, 2)),
      h('div.bubble', {}, h('div.who.row', { style: { gap: '6px' } }, `${d.alias} · supplier agent`, badge), d.message,
        d.score ? h('div.row.xs.faint', { style: { marginTop: '4px', gap: '8px' } }, h('span', {}, `match ${d.score}`), d.rating ? h('span', {}, `★ ${Number(d.rating).toFixed(2)}`) : null) : null)));
  } else if (e.type === 'negotiation.failed') {
    chat.append(h('div.sys', { style: { color: 'var(--danger)' } }, d.message));
  }
}
function transcript(j) {
  const chat = h('div.chat', { id: 'chat' });
  for (const e of j.events ?? []) if (e.type.startsWith('negotiation.')) appendChat(chat, e);
  return chat;
}

async function acceptQuote(quoteId, btn) {
  btn.disabled = true;
  try { await api(`/api/jobs/${state.job.id}/accept-quote?t=${encodeURIComponent(state.token)}`, { method: 'POST', body: { quote_id: quoteId } }); refetch(); } catch (e) { toast(e.message, true); btn.disabled = false; }
}

function viewScheduling(j) {
  const counters = (state.quotes ?? []).filter((q) => q.action === 'counter');
  const hasRound = (j.events ?? []).some((e) => e.type === 'negotiation.buyer_offer');
  const alias = (wid) => (j.events ?? []).find((e) => e.type === 'negotiation.supplier_response' && e.worker_id === wid)?.data.alias ?? wid;
  const seen = new Set();
  const uniq = counters.filter((q) => (seen.has(q.worker_id) ? false : seen.add(q.worker_id)));
  return h('div.col', { style: { gap: '14px' } },
    h('div.row.between', {}, h('h3', {}, 'Negoziazione live sul quando'), h('span.badge', {}, icon('agent'), 'A2A')),
    h('div.small.muted', {}, `Prezzo fisso ${eur(j.price.total_cents)} · ${j.window.flexible ? 'inizio flessibile nella fascia' : 'orario esatto'}`),
    transcript(j),
    !hasRound ? h('div.card.flat.small', {}, h('div.searchbar', { style: { marginBottom: '10px' } }), 'Il tuo agente sta chiedendo disponibilità ai partner…') : null,
    j.status_message && uniq.length ? h('div.col', {}, honest(j.status_message, 'Scegli una proposta alternativa: il prezzo viene ricalcolato per il nuovo orario.'),
      h('div.card', {}, uniq.map((q) => h('div.b-offerrow', {}, h('span.grow', {}, h('b', {}, alias(q.worker_id)), h('div.xs.faint', {}, q.message)),
        h('button.btn.sm.primary', { onclick: (e) => acceptQuote(q.id, e.currentTarget) }, 'Accetta'))))) : null,
    h('button.btn.block', { onclick: cancelJob }, 'Annulla'));
}

// ---- approval
function viewConfirm(j) {
  const d = j.deal;
  const lead = d.lead;
  const confirmBtn = h('button.btn.primary.lg.block', {
    onclick: async () => {
      confirmBtn.disabled = true;
      try { await api(`/api/jobs/${j.id}/confirm?t=${encodeURIComponent(state.token)}`, { method: 'POST', body: {} }); refetch(); } catch (e) { toast(e.message, true); confirmBtn.disabled = false; }
    },
  }, `${j.mode === 'now' ? 'Conferma adesso' : 'Conferma e programma'} · ${eur(j.price.total_cents)}`);
  return h('div.col', { style: { gap: '14px' } },
    h('div.card', { style: { boxShadow: 'var(--shadow)' } },
      h('div.row.between', {}, h('div.row', { style: { gap: '6px' } }, h('h3', {}, 'Slot bloccato'), h('span', { class: `badge ${j.mode === 'now' ? 'warn' : 'blue'}` }, j.mode === 'now' ? 'Adesso' : 'Programmato')), h('span.xs.faint', {}, `${d.rounds} round A2A`)),
      h('div.b-hero', { style: { margin: '10px 0 4px' } }, d.slot_label),
      j.headcount > 1 ? h('div.small.muted', {}, `Disponibilità confermata per ${d.seats_available} posti su ${j.headcount}`) : null,
      h('div.row', { style: { margin: '14px 0', alignItems: 'flex-start' } },
        avatar(lead.alias, '#000', lead.kind === 'business' ? 'sq' : ''),
        h('div.grow', {},
          h('b', {}, lead.alias),
          h('div.row.wrap', { style: { gap: '6px', margin: '4px 0' } }, h('span.badge.green', {}, icon('shield'), 'Verificato'), lead.insured ? h('span.badge', {}, 'RC assicurata') : null),
          h('div.small.muted', {}, `★ ${lead.rating?.toFixed(2) ?? '—'} (${lead.rating_count}) · match ${lead.score}${j.headcount > 1 ? ' · primo della coda' : ''}`),
          lead.how ? h('div.small', { style: { marginTop: '4px' } }, lead.how) : null)),
      h('div.row.between', {}, h('span.small.muted', {}, 'Prezzo fisso'), h('div.b-price.num', {}, eur(j.price.total_cents))),
      d.repriced ? h('div.xs', { style: { color: 'var(--warn-ink)' } }, 'Prezzo ricalcolato per il nuovo orario.') : null,
      h('div.sep'),
      h('dl.kv', {},
        ...j.price.lines.flatMap((l) => [h('dt', {}, l.label), h('dd.num', {}, eur(l.cents))]),
        ...j.price.surcharges.flatMap((s) => [h('dt', {}, s.label), h('dd.num', {}, eur(s.cents))]),
        h('dt', {}, 'Ai partner'), h('dd.num', {}, eur(j.price.payout_total_cents)),
        h('dt', {}, 'Commissione Aronica'), h('dd.num', {}, eur(j.price.fee_cents)),
        j.price.hold_cents ? h('dt', {}, 'Spesa pre-autorizzata') : null, j.price.hold_cents ? h('dd.num', {}, `fino a ${eur(j.price.hold_cents)}`) : null,
        h('dt', {}, 'Pagamento'), h('dd', {}, 'Escrow (stub, nessun addebito reale)'))),
    h('div.xs.faint', {}, `Se ${lead.alias} rifiuta o non risponde entro pochi secondi, l'offerta passa al prossimo partner libero in quello slot. Se non c'è nessuno te lo diciamo, senza inventare un match.`),
    j.account_kind !== 'business' ? h('div.xs.faint', {}, 'Aronica fa matching, dispatch e verifica della prova. Il servizio lo rende il partner (attività con P.IVA o privato verificato): non siamo il datore di lavoro.') : null,
    confirmBtn,
    h('div.row.between.small.muted', {}, h('span', {}, 'Annullamento gratuito fino a 24 ore prima'), h('button.linkbtn', { onclick: cancelJob }, 'Annulla')));
}

// ---- seats being filled / work in progress
function viewStaffing(j) {
  const pending = j.dispatch?.pending ?? [];
  const aliasOf = (wid) => (j.events ?? []).find((e) => e.type === 'dispatch.offer_sent' && e.worker_id === wid)?.data.alias ?? wid;
  const live = j.assignments.filter((a) => !['cancelled', 'no_show'].includes(a.status));
  const gone = j.assignments.filter((a) => ['cancelled', 'no_show'].includes(a.status));
  const rows = [];
  for (const a of live) rows.push(assignmentRow(a, j));
  const openCount = j.headcount - j.seats_filled;
  const pendRows = h('div');
  const drawPending = () => mount(pendRows, pending.map((o) => {
    const left = Math.max(0, Math.round((new Date(o.expires_at).getTime() - serverNow()) / 1000));
    return h('div.b-offerrow', {}, h('div.avatar', { style: { width: '32px', height: '32px', background: 'var(--bg-3)', color: 'var(--fg-2)' } }, icon('clock')),
      h('div.grow', {}, h('b', {}, aliasOf(o.worker_id)), h('div.xs.faint', {}, `offerta a tempo${o.seats > 1 ? ` per ${o.seats} posti` : ''}`)), h('span.badge.blue', {}, `${left}s`));
  }));
  drawPending();
  if (pending.length) timers.push(setInterval(drawPending, 1000));
  const single = j.headcount === 1 && live[0];
  const headline = single
    ? { assigned: `${single.worker.alias} è confermato/a`, en_route: `${single.worker.alias} è in viaggio`, on_site: `${single.worker.alias} è sul posto`, done: 'Lavoro consegnato' }[single.status] ?? j.status_label
    : j.status === 'dispatching' ? (j.headcount === 1 ? (j.dispatch?.tried > 1 ? 'Offerta passata al partner successivo…' : 'Offerta inviata al partner migliore…') : `Coperti ${j.seats_filled} ${j.seats_filled === 1 ? 'posto' : 'posti'} su ${j.headcount}`) : j.status_label;
  const events = (j.events ?? []).filter((e) => ['dispatch.offer_declined', 'dispatch.offer_expired', 'assignment.no_show', 'dispatch.replacement', 'job.worker_cancelled', 'job.partially_filled'].includes(e.type));
  return h('div.col', { style: { gap: '14px' } },
    h('div.b-hero', {}, headline),
    j.status === 'dispatching' ? h('div.searchbar') : null,
    j.approval ? h('div.small', {}, h('span', { class: `badge ${j.approval.by === 'policy' ? 'blue' : ''}` }, j.approval.by === 'policy' ? 'Approvato dalla policy aziendale' : 'Confermato da te'), j.approval.rule ? h('span.xs.faint', { style: { marginLeft: '6px' } }, j.approval.rule) : null) : null,
    j.status_message ? h('div.small', { style: { background: 'var(--bg-2)', padding: '10px 12px', borderRadius: '10px' } }, j.status_message) : null,
    events.length ? h('div.col', { style: { gap: '4px' } }, events.map((e) => h('div.small', { style: { color: 'var(--warn-ink)' } }, icon('alert'), ' ', eventText(e, j)))) : null,
    h('div.card', {},
      h('div.row.between', { style: { marginBottom: '6px' } }, h('b', {}, j.headcount > 1 ? `Posti · ${j.seats_filled}/${j.headcount}` : 'Partner'), h('span.xs.faint', {}, j.slot?.label)),
      rows.length ? rows : null,
      pendRows,
      openCount > 0 && !pending.length && j.status !== 'dispatching' ? h('div.small.muted', {}, `${openCount} posti non coperti`) : null,
      gone.length ? h('details', { style: { marginTop: '8px' } }, h('summary.xs.faint', {}, `${gone.length} sostituiti o annullati`), gone.map((a) => assignmentRow(a, j))) : null),
    h('dl.kv', {},
      h('dt', {}, 'Prezzo'), h('dd.num', {}, eur(j.price.total_cents)),
      h('dt', {}, 'Escrow'), h('dd', {}, j.escrow?.status === 'held' ? `Trattenuto (stub)${j.escrow.partial_refund_cents ? ` · rimborso ${eur(j.escrow.partial_refund_cents)}` : ''}` : j.escrow?.status ?? '—')),
    h('button.btn.block', { onclick: cancelJob }, 'Annulla'));
}

function eventText(e, j) {
  const name = j.assignments.find((a) => a.worker.worker_ref === e.worker_id)?.worker.alias
    ?? (j.events ?? []).find((x) => x.type === 'dispatch.offer_sent' && x.worker_id === e.worker_id)?.data.alias ?? 'Un partner';
  if (e.type === 'dispatch.offer_declined') return `${name} ha rifiutato: offerta al partner successivo.`;
  if (e.type === 'dispatch.offer_expired') return `${name} non ha risposto in tempo: offerta al partner successivo.`;
  if (e.type === 'assignment.no_show') return `${name} non si è presentato/a: sostituzione automatica avviata.`;
  if (e.type === 'dispatch.replacement') return `Offerta di sostituzione inviata per ${e.data.seats} posto/i.`;
  if (e.type === 'job.worker_cancelled') return `${name} ha annullato: cerco un sostituto.`;
  if (e.type === 'job.partially_filled') return e.data.message;
  return e.type;
}

function assignmentRow(a, j) {
  const w = a.worker;
  const st = { assigned: 'green', en_route: 'blue', on_site: 'blue', done: 'green', cancelled: 'red', no_show: 'red' }[a.status] ?? '';
  return h('div.b-offerrow', { style: { flexWrap: 'wrap' } },
    avatar(w.alias, w.avatar_color, w.kind === 'business' ? 'sq' : ''),
    h('div.grow', {},
      h('div.row', { style: { gap: '6px' } }, h('b', {}, w.alias), a.crew > 1 ? h('span.badge', {}, `squadra × ${a.crew}`) : null),
      h('div.xs.faint', {}, `★ ${w.rating?.toFixed(2) ?? 'nuovo'} · ${w.jobs_completed} lavori${w.insured ? ' · RC' : ''}`),
      a.status === 'en_route' ? h('div.xs', { 'data-eta': w.worker_ref, style: { color: 'var(--blue)' } }, `arriva in ${Math.max(1, w.eta_min)} min`) : null,
      a.proof?.timesheet ? h('div.xs.faint', {}, `check-in ${hhmm(a.proof.timesheet.check_in)} · check-out ${hhmm(a.proof.timesheet.check_out)} · ${Math.round(a.proof.timesheet.minutes_worked / 6) / 10} h`) : a.arrived_at && j.proof_kind === 'timesheet' ? h('div.xs.faint', {}, `check-in ${hhmm(a.arrived_at)}`) : null),
    h('div', { style: { textAlign: 'right' } },
      h('span', { class: `badge ${st}` }, a.status_label),
      a.contract ? h('div.xs.faint', { style: { marginTop: '4px' } }, a.contract.label) : null),
    a.worker.how && j.account_kind !== 'business' ? h('div.xs', { style: { width: '100%', marginLeft: '46px' } }, a.worker.how) : null,
    a.contract && j.account_kind === 'business' ? h('details', { style: { width: '100%' } }, h('summary.xs.faint', {}, 'Contratto e controlli'),
      h('pre.xs', { style: { whiteSpace: 'pre-wrap', background: 'var(--bg-2)', padding: '8px', borderRadius: '8px', fontFamily: 'inherit' } }, a.contract.text),
      a.contract.checks?.length ? h('div.col', { style: { gap: '2px' } }, a.contract.checks.map((c) => h('div.xs', { style: { color: c.ok ? 'var(--accent-ink)' : 'var(--danger)' } }, `${c.ok ? '✓' : '✗'} ${c.rule} — ${c.value}`)), a.contract.indicative ? h('div.xs.faint', {}, 'Limiti indicativi, da validare con un consulente del lavoro.') : null) : null) : null);
}

// ---- done
function viewDone(j) {
  const done = j.assignments.filter((a) => a.status === 'done');
  const q = Object.fromEntries((j.proof_requirements.checklist ?? []).map((c) => [c.id, c.q]));
  const fmt = (v) => (v === 'yes' ? 'Sì' : v === 'no' ? 'No' : String(v));
  const inv = j.invoice;
  return h('div.col', { style: { gap: '14px' } },
    h('div.row', {}, h('div.b-hero', {}, 'Fatto'), h('span.badge.green', {}, icon('check'), j.proof_kind === 'timesheet' ? 'Presenze verificate' : 'Prova verificata')),
    j.status_message ? h('div.small', { style: { background: 'var(--bg-2)', padding: '10px 12px', borderRadius: '10px' } }, j.status_message) : null,
    done.map((a) => h('div.card', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div.row', {}, avatar(a.worker.alias, a.worker.avatar_color, a.worker.kind === 'business' ? 'sq' : ''), h('div.grow', {}, h('b', {}, a.worker.alias), h('div.xs.faint', {}, a.contract?.label)), h('b.num', {}, eur(a.payout_cents))),
      a.proof?.simulated ? h('div.xs.faint', {}, 'Prova prodotta dal simulatore demo (partner seed).') : null,
      a.proof?.photos?.length ? h('div.photos', {}, a.proof.photos.map((src, i) => h('div', { style: { position: 'relative' } },
        h('img', { src, alt: j.proof_requirements.shots?.[i] ?? 'Foto prova', onclick: () => lightbox(src), style: { cursor: 'zoom-in' } }),
        j.proof_requirements.shots?.[i] ? h('span.xs', { style: { position: 'absolute', left: '4px', bottom: '4px', background: 'rgba(0,0,0,.65)', color: '#fff', padding: '1px 6px', borderRadius: '6px', pointerEvents: 'none' } }, j.proof_requirements.shots[i]) : null))) : null,
      a.proof?.timesheet ? h('div.small', {}, `Check-in ${hhmm(a.proof.timesheet.check_in)} · check-out ${hhmm(a.proof.timesheet.check_out)} · ${Math.round(a.proof.timesheet.minutes_worked / 6) / 10} h lavorate`) : null,
      h('div.req', {}, h('span.badge.green', {}, icon('pin'), `GPS a ${a.proof.gps.distance_m} m (max ${a.proof.gps.radius_m})${a.proof.gps.simulated_position ? ' · simulato' : ''}`)),
      Object.keys(a.proof.answers ?? {}).length ? h('dl.kv', {}, Object.entries(a.proof.answers).flatMap(([k, v]) => [h('dt', {}, q[k] ?? k), h('dd', {}, fmt(v))])) : null,
      a.buyer_rating ? h('div.small.muted', {}, `Hai valutato: ★ ${a.buyer_rating}`) : ratingWidget(j, a))),
    h('dl.kv', {},
      h('dt', {}, 'Pagato ai partner'), h('dd.num', {}, eur(j.escrow?.paid_to_partners_cents)),
      h('dt', {}, 'Commissione'), h('dd.num', {}, eur(j.escrow?.platform_fee_cents)),
      j.escrow?.purchase_reimbursed_cents ? h('dt', {}, 'Spesa rimborsata (scontrino)') : null, j.escrow?.purchase_reimbursed_cents ? h('dd.num', {}, eur(j.escrow.purchase_reimbursed_cents)) : null,
      h('dt', {}, 'Escrow'), h('dd', {}, 'Rilasciato (stub)')),
    inv ? h('div.card', {}, h('div.row.between', {}, h('b', {}, `Fattura ${inv.number}`), h('span.badge.warn', {}, inv.status)),
      h('div.xs.faint', { style: { margin: '4px 0 8px' } }, `${inv.to.name} · ${inv.to.vat_id ?? ''} · SDI ${inv.to.sdi ?? '—'}`),
      h('dl.kv', {}, h('dt', {}, 'Imponibile'), h('dd.num', {}, eur(inv.imponibile_cents)), h('dt', {}, 'IVA 22%'), h('dd.num', {}, eur(inv.iva_cents)), h('dt', {}, h('b', {}, 'Totale')), h('dd.num', {}, h('b', {}, eur(inv.totale_cents))))) : null);
}

function ratingWidget(j, a) {
  let stars = 0;
  const tags = new Set();
  const starsBox = h('div.stars');
  const tagBox = h('div.chips');
  const draw = () => {
    mount(starsBox, [1, 2, 3, 4, 5].map((n) => h('button.star-btn', { class: n <= stars ? 'on' : '', onclick: () => { stars = n; tags.clear(); draw(); } }, icon('star'))));
    mount(tagBox, stars ? Object.entries(cfg.rating_tags).filter(([, t]) => t.positive === stars >= 4).map(([k, t]) =>
      h('button.chip', { class: tags.has(k) ? 'on' : '', onclick: () => { tags.has(k) ? tags.delete(k) : tags.add(k); draw(); } }, t.label_it + (t.excluded ? ' (non conta)' : ''))) : []);
  };
  draw();
  return h('div', {}, h('div.small', {}, `Com'è andata con ${a.worker.alias}?`), starsBox, tagBox,
    h('button.btn.sm.primary', {
      style: { marginTop: '8px' },
      onclick: async () => {
        if (!stars) return toast('Scegli da 1 a 5 stelle', true);
        try { await api(`/api/jobs/${j.id}/rating?t=${encodeURIComponent(state.token)}`, { method: 'POST', body: { worker_ref: a.worker.worker_ref, stars, tags: [...tags] } }); toast('Grazie per la valutazione'); refetch(); } catch (e) { toast(e.message, true); }
      },
    }, 'Invia valutazione'));
}

function viewClosed(j) {
  return h('div.col', { style: { gap: '14px' } },
    honest(j.status_message || j.status_label, j.escrow ? `Escrow: ${j.escrow.status}${j.escrow.cancel_fee_cents ? ` · penale ${eur(j.escrow.cancel_fee_cents)}` : ''}` : null),
    h('button.btn.primary.block', { onclick: () => go('#/') }, 'Nuova richiesta'),
    (j.events ?? []).some((e) => e.type.startsWith('negotiation.')) ? h('details', {}, h('summary.small', {}, 'Trascrizione'), transcript(j)) : null);
}

const cancelJob = twoStep('Tocca di nuovo per annullare', async () => {
  try { await api(`/api/jobs/${state.job.id}/cancel?t=${encodeURIComponent(state.token)}`, { method: 'POST', body: {} }); refetch(); } catch (e) { toast(e.message, true); }
});

// ---- map
function drawJobMap(animate, refit = true) {
  const j = state.job;
  const loc = j.location;
  map.set('task', { lat: loc.lat, lng: loc.lng, html: taskPin(j.status === 'done' ? 'Fatto' : j.service_name, { done: j.status === 'done', pulse: j.status === 'dispatching' || j.status === 'scheduling' }) });
  const pts = [loc];
  const seen = new Set();
  for (const a of j.assignments.filter((x) => ['assigned', 'en_route', 'on_site', 'done'].includes(x.status))) {
    const w = a.worker;
    seen.add(`w:${w.worker_ref}`);
    map.set(`w:${w.worker_ref}`, { lat: w.position.lat, lng: w.position.lng, html: workerPin(w.alias, w.avatar_color, { label: a.status === 'en_route' ? `${Math.max(1, w.eta_min)} min` : null }), z: 500, animate });
    pts.push(w.position);
  }
  const single = j.assignments.find((a) => a.status === 'en_route');
  if (single) map.line('route', [single.worker.position, loc], { weight: 4 }); else map.line('route', null);
  if (!animate && refit) { if (pts.length > 1) map.fit(pts, 80); else map.view(loc, 14); }
}

// ------------------------------------------------------------------ boot
export async function mountBuyer({ panelEl, mapEl, hash = true }) {
  panel = panelEl;
  useHash = hash;
  cfg = await api('/api/config');
  setClockOffset(cfg.clock_offset_ms);
  map = createMap(mapEl, { zoom: 12, onClick: (p) => map.onPick?.(p) });
  if (useHash) window.addEventListener('hashchange', route);
  route();
}

