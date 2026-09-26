// Simulated assistant app. The chat is the assistant's own UI (it stands in for
// Muse / Instinct / ChatGPT…); the black cards inside it are Aronica's connector
// UI: proposal (Adesso / Programma), confirm, live status, proof and rating.
// Talks to: /api/assistant/* (the simulated assistant backend, which calls
// Aronica's tools server-side) and the Confirm API /api/jobs/:id?t=… (token).
import { h, mount, api, sse, eur, icon, avatar, lightbox, hhmm, serverNow, setClockOffset } from '/shared/common.js';

const SUGGESTIONS = [
  { label: 'Auto all\'autolavaggio', text: 'Porta la mia auto all\'autolavaggio sabato mattina e riportamela — Navigli, berlina, interno+esterno.' },
  { label: 'Aspetta il tecnico', text: 'Domani viene il tecnico della lavatrice: aspettalo a casa mia a Porta Romana dalle 9 alle 13.' },
  { label: 'Ritiro in farmacia', text: 'Ritira un farmaco alla Farmacia di Porta Ticinese e portamelo a casa entro le 19, zona Navigli.' },
  { label: 'Montaggio IKEA', text: 'Montare 2 librerie IKEA Billy giovedì dalle 17 alle 21 a Isola.' },
  { label: 'Insegnante di Capoeira', text: 'Trovami un insegnante di Capoeira ai Navigli per stasera.' },
];
const STORE = 'aronica.assistant.v1';

let chat;
let busy = false;
let live = null; // { es, jobId, token, el, job }
const history = []; // persisted: [{ role, text }] + the active job

const save = () => { try { localStorage.setItem(STORE, JSON.stringify({ history: history.slice(-40), live: live && { jobId: live.jobId, token: live.token } })); } catch { /* */ } };
const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };

function scroll() { requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; }); }
function add(el) { chat.append(el); scroll(); return el; }
function say(role, text, { persist = true } = {}) {
  if (persist) { history.push({ role, text }); save(); }
  return add(h(`div.as-msg.${role}`, {}, text));
}
function trace(steps) {
  if (!steps?.length) return;
  add(h('details.as-trace', {}, h('summary', {}, `↳ ${steps.length} chiamate al connettore Aronica`),
    h('div', {}, steps.map((s) => h('code', { class: s.ok ? '' : 'err' }, s.tool)))));
}
function typing(label = 'sta scrivendo…') { return add(h('div.as-typing', {}, label)); }

const arCard = (right, ...body) => h('div.ar-card', {},
  h('div.ar-head', {}, h('span.logo', {}, h('i'), 'Aronica'), h('span', {}, right)),
  h('div.ar-body', {}, ...body));

// ------------------------------------------------------------------ flow
async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  say('user', text);
  const t = typing();
  try {
    const r = await api('/api/assistant/plan', { method: 'POST', body: { text } });
    t.remove();
    if (r.kind === 'proposal') { say('bot', r.reply); trace(r.trace); add(proposalCard(r.proposal)); }
    else refusal(r);
  } catch (e) {
    t.remove();
    say('bot', `Non riesco a contattare Aronica: ${e.message}`);
  } finally { busy = false; }
}

function refusal(r) {
  say('bot', r.reply);
  if (r.reason || r.detail) add(h('div.as-msg.sys', {}, [r.reason, r.detail].filter(Boolean).join(' · ')));
  trace(r.trace);
}

function proposalCard(p) {
  const opt = (mode, o, label) => h('button.ar-opt', {
    disabled: !o || !o.available,
    onclick: (e) => { for (const b of e.currentTarget.parentElement.children) b.disabled = true; book(p.text, mode); },
  }, h('span.xs.faint', {}, label), h('b', {}, o ? eur(o.price_cents) : '—'),
  h('span.xs', {}, o ? (o.available ? o.window : 'Nessuno disponibile ora') : '—'));
  return arCard(p.service,
    h('div.ar-title', {}, p.title),
    h('div.ar-row.small.muted', {}, icon('pin'), p.address, p.duration ? ` · circa ${p.duration}` : ''),
    p.partners.length ? h('div', {}, p.partners.map((w) => h('div.ar-partner', {},
      avatar(w.alias, '#000', w.kind === 'business' ? 'sq' : ''),
      h('div', {}, h('b', {}, w.alias), h('div.xs.faint', {}, `★ ${w.rating?.toFixed(2) ?? '—'} · ${w.distance_km} km${w.kind === 'business' ? ' · attività' : ''}`), w.how ? h('div.xs', {}, w.how) : null)))) : null,
    p.proof ? h('div.xs.muted', {}, `Prova: foto ${p.proof.join(', ').toLowerCase()} + GPS`) : null,
    h('div.ar-opts', {}, opt('now', p.now, 'Adesso'), opt('scheduled', p.scheduled, 'Programma')),
    h('div.xs.faint', {}, 'Prezzo fisso della piattaforma: gli agenti negoziano solo lo slot.'));
}

async function book(text, mode) {
  busy = true;
  const t = typing('chiedo ai partner…');
  try {
    const r = await api('/api/assistant/book', { method: 'POST', body: { text, mode } });
    t.remove();
    handleBooking(r);
  } catch (e) { t.remove(); say('bot', `Errore: ${e.message}`); } finally { busy = false; }
}

function handleBooking(r) {
  if (r.kind === 'confirm') { say('bot', r.reply); trace(r.trace); add(confirmCard(r.confirm)); return; }
  if (r.kind === 'counters' && r.counters.length) {
    say('bot', `${r.reply} Vuoi uno di questi orari?`);
    trace(r.trace);
    add(arCard('Altri orari', h('div.col', { style: { gap: '8px' } }, r.counters.map((c) => h('button.btn.block', {
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        const x = await api('/api/assistant/accept', { method: 'POST', body: { job_id: r.job_id, quote_id: c.quote_id } }).catch((err) => ({ kind: 'refusal', reply: err.message }));
        handleBooking(x);
      },
    }, `${c.slot_label} · ${c.alias}`)))));
    return;
  }
  refusal(r);
}

function confirmCard(c) {
  const btn = h('button.btn.primary.lg.block', {
    onclick: async () => {
      btn.disabled = true;
      try {
        await api(`/api/jobs/${c.job_id}/confirm?t=${encodeURIComponent(c.token)}`, { method: 'POST', body: {} });
        btn.replaceWith(h('div.badge.green', {}, icon('check'), ' Confermato'));
        say('user', 'Confermo');
        follow(c.job_id, c.token);
      } catch (e) { btn.disabled = false; say('bot', e.message); }
    },
  }, `${c.mode === 'now' ? 'Conferma adesso' : 'Conferma e programma'} · ${eur(c.price_cents)}`);
  return arCard(c.mode === 'now' ? 'Adesso' : 'Programmato',
    h('div.ar-title', {}, c.title),
    h('div.ar-row.small.muted', {}, icon('calendar'), c.slot_label),
    h('div.ar-partner', {}, avatar(c.lead.alias, '#000', c.lead.kind === 'business' ? 'sq' : ''),
      h('div', {}, h('b', {}, c.lead.alias), h('div.xs.faint', {}, `Verificato · ★ ${c.lead.rating?.toFixed(2) ?? '—'} (${c.lead.rating_count})`), c.lead.how ? h('div.xs', {}, c.lead.how) : null)),
    h('dl.kv', {}, ...c.lines.flatMap((l) => [h('dt', {}, l.label), h('dd.num', {}, eur(l.cents))]),
      ...c.surcharges.flatMap((s) => [h('dt', {}, s.label), h('dd.num', {}, eur(s.cents))])),
    h('div.ar-row.between', {}, h('span.small.muted', {}, 'Prezzo fisso'), h('span.ar-price', {}, eur(c.price_cents))),
    h('div.xs.faint', {}, 'Pagamento in escrow (stub, nessun addebito reale). Se il partner rifiuta, l\'offerta passa al successivo; se non c\'è nessuno te lo diciamo.'),
    btn,
    h('a.xs.muted', { href: c.confirm_url.replace(/^https?:\/\/[^/]+/, ''), target: '_blank' }, 'Apri nella pagina Aronica'));
}

// ------------------------------------------------------------------ live status
const STEPS = [['dispatching', 'Offerta al partner'], ['assigned', 'Confermato'], ['en_route', 'In viaggio'], ['on_site', 'Sul posto'], ['done', 'Fatto']];

function follow(jobId, token) {
  live?.es?.close();
  const el = add(arCard('In corso', h('div.small.muted', {}, 'Collegamento…')));
  live = { jobId, token, el, job: null, es: null, said: new Set(), pending: null };
  save();
  refresh();
  live.es = sse(`/api/jobs/${encodeURIComponent(jobId)}/stream?t=${encodeURIComponent(token)}&since=0`, onEvent);
}

async function refresh() {
  if (!live) return;
  try {
    const r = await api(`/api/jobs/${live.jobId}?t=${encodeURIComponent(live.token)}`);
    live.job = r.job;
    drawLive();
  } catch (e) { mount(live.el.querySelector('.ar-body'), h('div.small', {}, e.message)); }
}

function stage(j) {
  const a = j.assignments.find((x) => !['cancelled', 'no_show'].includes(x.status));
  if (j.status === 'done') return 'done';
  if (a) return a.status === 'assigned' ? 'assigned' : a.status;
  return j.status;
}

function drawLive() {
  const j = live.job;
  const s = stage(j);
  const idx = s === 'done' ? STEPS.length : STEPS.findIndex(([k]) => k === s);
  const a = j.assignments.find((x) => !['cancelled', 'no_show'].includes(x.status));
  const pending = j.dispatch?.pending?.[0];
  const body = live.el.querySelector('.ar-body');
  const head = live.el.querySelector('.ar-head span:last-child');
  head.textContent = j.status_label;
  const closed = ['no_match', 'cancelled', 'expired'].includes(j.status);
  mount(body,
    h('div.ar-title', {}, j.title),
    h('div.ar-row.small.muted', {}, icon('calendar'), j.slot?.label ?? j.window.label),
    closed ? h('div.empty', {}, h('div', {}, h('b', {}, j.status_message || j.status_label), j.escrow ? h('div.xs.faint', {}, `Escrow: ${j.escrow.status}`) : null)) : h('div.ar-steps', {},
      STEPS.map(([k, label], i) => h('div.ar-step', { class: i < idx ? 'done' : i === idx ? 'on' : '' }, h('span.dotx'), label,
        k === 'dispatching' && i === idx && pending ? h('span.xs.faint', { 'data-exp': pending.expires_at }, '') : null,
        k === 'en_route' && i === idx && a ? h('span.xs.faint', {}, `· arriva in ${Math.max(1, a.worker.eta_min)} min`) : null))),
    a ? h('div.ar-partner', {}, avatar(a.worker.alias, a.worker.avatar_color, a.worker.kind === 'business' ? 'sq' : ''),
      h('div', {}, h('b', {}, a.worker.alias), h('div.xs.faint', {}, `★ ${a.worker.rating?.toFixed(2) ?? '—'} · ${a.contract?.label ?? ''}`))) : null,
    j.status === 'done' ? doneBlock(j) : null);
  tickTtl();
}

function doneBlock(j) {
  const shots = j.proof_requirements?.shots ?? [];
  return h('div.col', { style: { gap: '10px' } }, j.assignments.filter((x) => x.status === 'done').map((a) => h('div.col', { style: { gap: '8px' } },
    a.proof?.simulated ? h('div.xs.faint', {}, 'Foto prodotte dal simulatore (partner seed, non reale).') : null,
    h('div.photos', {}, (a.proof?.photos ?? []).map((src, i) => h('div', { style: { position: 'relative' } },
      h('img', { src, alt: shots[i] ?? 'Foto', onclick: () => lightbox(src), style: { cursor: 'zoom-in' } }),
      shots[i] ? h('span.xs', { style: { position: 'absolute', left: '4px', bottom: '4px', background: 'rgba(0,0,0,.65)', color: '#fff', padding: '1px 6px', borderRadius: '6px' } }, shots[i]) : null))),
    h('div.xs.muted', {}, `GPS a ${a.proof?.gps?.distance_m ?? '—'} m · consegnata ${hhmm(a.completed_at)}`),
    a.buyer_rating ? h('div.small', {}, `Hai dato ${'★'.repeat(a.buyer_rating)}`) : stars(j, a))));
}

function stars(j, a) {
  const box = h('div.ar-stars');
  [1, 2, 3, 4, 5].forEach((n) => box.append(h('button', {
    'aria-label': `${n} stelle`,
    onclick: async () => {
      try {
        await api(`/api/jobs/${j.id}/rating?t=${encodeURIComponent(live.token)}`, { method: 'POST', body: { worker_ref: a.worker.worker_ref, stars: n } });
        say('user', '★'.repeat(n));
        say('bot', 'Grazie, ho lasciato la valutazione.');
        refresh();
      } catch (e) { say('bot', e.message); }
    },
  }, '★')));
  return h('div', {}, h('div.small', {}, `Com'è andata con ${a.worker.alias}?`), box);
}

function tickTtl() {
  for (const el of document.querySelectorAll('[data-exp]')) {
    el.textContent = `· ${Math.max(0, Math.round((new Date(el.dataset.exp) - serverNow()) / 1000))}s per rispondere`;
  }
}
setInterval(tickTtl, 1000);

// The assistant narrates the important moments in the conversation.
function onEvent(e) {
  if (!live || e.job_id && e.job_id !== live.jobId) { if (e.type === 'clock.changed') setClockOffset(e.data.offset_ms); return; }
  if (e.type === 'clock.changed') setClockOffset(e.data.offset_ms);
  const d = e.data ?? {};
  const once = (key, text) => { if (live.said.has(key)) return; live.said.add(key); say('bot', text, { persist: false }); };
  if (e.type === 'worker.location') {
    const a = live.job?.assignments.find((x) => x.worker.worker_ref === e.worker_id);
    if (a) { a.worker.eta_min = d.eta_min; drawLive(); }
    return;
  }
  if (e.type === 'dispatch.offer_sent') once(`sent:${e.seq}`, `Ho inviato l'offerta a ${d.alias}: ha ${d.ttl_s} secondi per accettare.`);
  else if (e.type === 'dispatch.offer_declined' || e.type === 'dispatch.offer_expired') once(`no:${e.seq}`, e.type === 'dispatch.offer_declined' ? 'Il partner ha rifiutato: passo al successivo.' : 'Il partner non ha risposto in tempo: passo al successivo.');
  else if (e.type === 'job.assigned') once(`as:${e.seq}`, `${d.worker?.alias ?? 'Il partner'} ha accettato. Ti aggiorno io.`);
  else if (e.type === 'job.en_route') once('route', 'È partito/a: lo vedi arrivare qui sotto.');
  else if (e.type === 'job.on_site') once('site', 'È arrivato/a sul posto.');
  else if (e.type === 'job.done') once('done', 'Fatto. Ecco la prova: foto e posizione verificate.');
  else if (e.type === 'job.no_match') once('nm', d.message ?? 'Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta.');
  else if (e.type === 'job.cancelled') once('cx', 'Annullato.');
  refreshSoon();
}
let rq;
function refreshSoon() { clearTimeout(rq); rq = setTimeout(refresh, 200); }

// ------------------------------------------------------------------ boot
export async function mountAssistant() {
  chat = document.getElementById('chat');
  const text = document.getElementById('text');
  const form = document.getElementById('form');
  try { setClockOffset((await api('/api/config')).clock_offset_ms); } catch { /* */ }
  mount(document.getElementById('sugg'), SUGGESTIONS.map((s) => h('button.chip', { type: 'button', onclick: () => { text.value = s.text; text.focus(); } }, s.label)));
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = text.value; text.value = ''; send(v); });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  const prev = load();
  add(h('div.as-msg.sys', {}, 'Demo: questo assistente è uno script (nessun LLM) che usa i tool MCP di Aronica. Le carte nere sono l\'interfaccia di Aronica dentro l\'assistente.'));
  if (prev?.history?.length) {
    for (const m of prev.history) { history.push(m); add(h(`div.as-msg.${m.role}`, {}, m.text)); }
    if (prev.live) follow(prev.live.jobId, prev.live.token);
    add(h('button.btn.sm', { style: { alignSelf: 'center' }, onclick: () => { try { localStorage.removeItem(STORE); } catch { /* */ } location.reload(); } }, 'Nuova conversazione'));
  } else {
    say('bot', 'Ciao! Dimmi cosa ti serve oggi. Se è una cosa da fare fisicamente a Milano, la chiedo ad Aronica.', { persist: false });
  }
}
