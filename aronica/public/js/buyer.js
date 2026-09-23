// Buyer console (the human watching the agent). Live A2A negotiation transcript
// → Uber-style one-tap confirm (Adesso / Programma) → live status to Fatto.
import {
  h, mount, api, sse, eur, pct, hhmm, dayhhmm, deadlineText, toast, icon, avatar, VEHICLE_IT,
  createMap, taskPin, workerPin, lightbox,
} from './common.js';

const panel = document.getElementById('panel');
const MY_JOBS = 'aronica.buyer_jobs';
let cfg;
let map;
let es = null;
let state = null;          // { job, quotes, token }
let timers = [];

const loadMine = () => { try { return JSON.parse(localStorage.getItem(MY_JOBS) || '[]'); } catch { return []; } };
const saveMine = (list) => { try { localStorage.setItem(MY_JOBS, JSON.stringify(list.slice(0, 20))); } catch { /* */ } };
function remember(id, token, title) {
  saveMine([{ id, token, title, at: Date.now() }, ...loadMine().filter((j) => j.id !== id)]);
}

function clearTimers() { timers.forEach(clearInterval); timers = []; }

// ------------------------------------------------------------------ router
async function route() {
  clearTimers();
  es?.close(); es = null;
  const m = /^#\/job\/([^?]+)\?t=(.+)$/.exec(location.hash);
  if (m) return openJob(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  return renderHome();
}

// ------------------------------------------------------------------ home / new request
const EXAMPLES = [
  {
    label: 'Scaffale Esselunga (happy path)',
    skill: null, place: 'Corso Vittorio Emanuele', title: 'Il Pesto alla Genovese Barilla 190g è davvero a scaffale?',
    detail: 'Esselunga, Corso Vittorio Emanuele', deadline: 120, target: 14, max: 22,
    instructions: 'Vai al reparto sughi pronti\nFotografa l\'intero lineare dei pesti\nFotografa da vicino il cartellino prezzo del Pesto Barilla 190g\nConta i facing visibili',
  },
  {
    label: 'Foto vetrina a Brera',
    skill: 'store_photo', place: 'Brera', title: 'Foto della vetrina e dell\'insegna del nostro pop-up in via Brera 12',
    detail: 'Via Brera 12', deadline: 180, target: 12, max: 20,
    instructions: 'Foto frontale della vetrina\nFoto dell\'insegna\nFoto dell\'ingresso con l\'orario esposto\nFoto di una vista laterale della strada',
  },
  {
    label: 'Capoeira (deve fallire)',
    skill: null, place: 'Navigli', title: 'Trovami un insegnante di Capoeira ai Navigli per stasera',
    detail: '', deadline: 240, target: 30, max: 50, instructions: '',
  },
];

async function renderHome() {
  map.clear();
  const f = { skill: null, place: 'Corso Vittorio Emanuele', custom: null, deadline: 120, title: '', detail: '', instructions: '', target: '', max: '' };
  const skillChips = h('div.chips');
  const drawSkills = () => mount(skillChips,
    h('button.chip', { class: f.skill ? '' : 'on', onclick: () => { f.skill = null; drawSkills(); } }, 'Auto'),
    cfg.skills.map((s) => h('button.chip', { class: f.skill === s.code ? 'on' : '', onclick: () => { f.skill = s.code; drawSkills(); } }, s.name_it)));
  drawSkills();
  const placeSel = h('select.input', { onchange: (e) => { f.place = e.target.value; f.custom = null; pinPlace(); } },
    cfg.places.map((p) => h('option', { value: p.name, selected: p.name === f.place }, p.name)));
  const deadlineChips = h('div.chips');
  const DL = [[60, '1 ora'], [120, '2 ore'], [240, '4 ore'], [480, '8 ore'], [1440, 'Domani']];
  const drawDl = () => mount(deadlineChips, DL.map(([m, l]) => h('button.chip', { class: f.deadline === m ? 'on' : '', onclick: () => { f.deadline = m; drawDl(); } }, l)));
  drawDl();
  const title = h('textarea.input', { rows: 2, placeholder: 'Es. Il prodotto X è a scaffale all\'Esselunga di Corso Buenos Aires?', oninput: (e) => { f.title = e.target.value; } });
  const detail = h('input.input', { placeholder: 'Negozio / indirizzo preciso (es. Esselunga, Corso Buenos Aires 23)', oninput: (e) => { f.detail = e.target.value; } });
  const instr = h('textarea.input', { rows: 4, placeholder: 'Un passo per riga', oninput: (e) => { f.instructions = e.target.value; } });
  const target = h('input.input', { type: 'number', min: 1, step: 0.5, placeholder: 'Obiettivo €', oninput: (e) => { f.target = e.target.value; } });
  const max = h('input.input', { type: 'number', min: 1, step: 0.5, placeholder: 'Massimo €', oninput: (e) => { f.max = e.target.value; } });
  const result = h('div');
  const placeLabel = h('div.xs.faint');

  function pinPlace() {
    const p = f.custom ?? cfg.places.find((x) => x.name === f.place);
    map.set('task', { lat: p.lat, lng: p.lng, html: taskPin(f.custom ? 'Punto scelto' : p.name) });
    map.view(p, 15);
    placeLabel.textContent = f.custom ? `Punto sulla mappa: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'Oppure clicca sulla mappa per scegliere il punto esatto.';
  }
  map.onPick = (p) => { f.custom = p; pinPlace(); };

  const fill = (ex) => {
    f.skill = ex.skill; f.place = ex.place; f.custom = null; f.deadline = ex.deadline;
    f.title = title.value = ex.title; f.detail = detail.value = ex.detail; f.instructions = instr.value = ex.instructions;
    f.target = target.value = ex.target; f.max = max.value = ex.max;
    placeSel.value = ex.place;
    drawSkills(); drawDl(); pinPlace(); mount(result);
  };

  const submit = async (btn) => {
    btn.disabled = true;
    mount(result);
    const p = f.custom ?? cfg.places.find((x) => x.name === f.place);
    try {
      const r = await api('/api/console/jobs', {
        method: 'POST',
        body: {
          title: f.title.trim(), skill: f.skill ?? undefined,
          location: { lat: p.lat, lng: p.lng, address: [f.detail.trim(), f.custom || f.detail.toLowerCase().includes(f.place.toLowerCase()) ? null : f.place].filter(Boolean).join(' · ') || undefined },
          deadline_minutes: f.deadline, instructions: f.instructions,
          budget: { target_eur: f.target ? Number(f.target) : undefined, max_eur: f.max ? Number(f.max) : undefined },
        },
      });
      remember(r.job.id, r.token, r.job.title);
      // The console's buyer agent starts negotiating right away.
      api(`/api/jobs/${r.job.id}/auto-negotiate?t=${encodeURIComponent(r.token)}`, { method: 'POST', body: {} }).catch(() => {});
      location.hash = `#/job/${r.job.id}?t=${r.token}`;
    } catch (e) {
      btn.disabled = false;
      mount(result, honest(e.message, e.data?.detail));
    }
  };

  const mine = loadMine();
  mount(panel,
    h('div', {}, h('div.b-hero', {}, 'Di cosa hai bisogno sul posto, a Milano?'),
      h('p.muted.small', {}, 'Un agente negozia con i partner verificati, tu confermi con un tap. Solo verifiche sul campo: scaffali, foto, prezzi, presenza, sopralluoghi, documenti.')),
    h('div.b-examples', {}, h('div.xs.faint', { style: { marginBottom: '6px' } }, 'ESEMPI'), h('div.chips', {}, EXAMPLES.map((ex) => h('button.chip', { onclick: () => fill(ex) }, ex.label)))),
    h('label.field', {}, h('span', {}, 'Richiesta'), title),
    h('div.field', {}, h('span', {}, 'Tipo di lavoro'), skillChips),
    h('label.field', {}, h('span', {}, 'Dove'), placeSel, detail, placeLabel),
    h('div.field', {}, h('span', {}, 'Entro'), deadlineChips),
    h('label.field', {}, h('span', {}, 'Istruzioni per il partner'), instr),
    h('div.field', {}, h('span', {}, 'Budget (il tuo agente non supera il massimo)'), h('div.row', {}, target, max)),
    result,
    h('button.btn.primary.lg.block', { onclick: (e) => submit(e.currentTarget) }, 'Trova persone'),
    mine.length ? h('div', {}, h('h3', { style: { margin: '12px 0 6px' } }, 'Le tue richieste'),
      h('div.list', {}, mine.slice(0, 8).map((j) => h('a.item', { href: `#/job/${j.id}?t=${j.token}`, style: { textDecoration: 'none' } },
        icon('list'), h('div.grow.small', {}, j.title, h('div.xs.faint', {}, new Date(j.at).toLocaleString('it-IT'))), icon('chevron'))))) : null,
    h('div.card.flat.small', {}, h('b', {}, 'Hai un agente AI? '), 'Claude, Grok, OpenAI o qualsiasi agente con tool-use può creare e negoziare lavori via MCP/API. Tu ricevi il link di conferma. ', h('a', { href: '/docs' }, 'Connetti un agente →')),
  );
  pinPlace();
}

function honest(message, detail) {
  return h('div.empty', {},
    h('div.ico', {}, icon('info')),
    h('div', {}, h('b', {}, message), detail ? h('div.small.muted', { style: { marginTop: '4px' } }, detail) : null));
}

// ------------------------------------------------------------------ job view
async function openJob(id, token) {
  try {
    const r = await api(`/api/jobs/${id}?t=${encodeURIComponent(token)}`);
    state = { job: r.job, quotes: r.quotes, token };
    remember(id, token, r.job.title);
  } catch (e) {
    mount(panel, honest('Link non valido', e.message), h('a.btn.block', { href: '#/' }, 'Nuova richiesta'));
    return;
  }
  map.clear();
  map.onPick = null;
  renderJob(true);
  const since = Math.max(0, ...(state.job.events ?? []).map((e) => e.seq ?? 0));
  es = sse(`/api/stream?job=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}&since=${since}`, onJobEvent);
}

let refetchT = null;
function refetch() {
  clearTimeout(refetchT);
  refetchT = setTimeout(async () => {
    if (!state) return;
    const r = await api(`/api/jobs/${state.job.id}?t=${encodeURIComponent(state.token)}`);
    const prevStatus = state.job.status;
    state.job = r.job; state.quotes = r.quotes;
    renderJob(prevStatus !== r.job.status);
  }, 120);
}

function onJobEvent(e) {
  if (!state) return;
  if (e.type === 'worker.location') {
    if (state.job.worker) {
      state.job.worker.position = { lat: e.data.lat, lng: e.data.lng };
      state.job.worker.eta_min = e.data.eta_min;
      drawJobMap(true);
      const el = document.getElementById('etaBig');
      if (el) el.textContent = etaLine(state.job);
    }
    return;
  }
  // Append live transcript events without a full re-render (feels live).
  if (e.type.startsWith('negotiation.') && e.type !== 'negotiation.deal') {
    state.job.events = [...(state.job.events ?? []), e];
    const chat = document.getElementById('chat');
    if (chat) { appendChatEvent(chat, e); chat.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    if (e.type === 'negotiation.failed') refetch();
    return;
  }
  state.job.events = [...(state.job.events ?? []), e];
  refetch();
}

const STEP = ['dispatching', 'assigned', 'en_route', 'on_site', 'done'];

function renderJob(statusChanged) {
  clearTimers();
  const j = state.job;
  drawJobMap(false, statusChanged);
  const header = h('div', {},
    h('div.row.between', {}, h('span.badge', { class: statusBadgeClass(j.status) }, j.status_label), h('span.xs.faint', {}, `Richiesto da ${j.agent_name}`)),
    h('h2', { style: { marginTop: '8px' } }, j.title),
    h('div.row.small.muted', { style: { marginTop: '6px' } }, icon('pin'), j.location.address),
    h('div.row.small.muted', {}, icon('clock'), deadlineText(j.deadline_at), h('span', {}, '·'), j.skill_name));

  let body;
  switch (j.status) {
    case 'negotiating': body = viewNegotiating(j); break;
    case 'pending_confirmation': body = viewConfirm(j); break;
    case 'dispatching': body = viewDispatching(j); break;
    case 'assigned': case 'en_route': case 'on_site': body = viewTracking(j); break;
    case 'done': body = viewDone(j); break;
    default: body = viewClosed(j);
  }
  mount(panel, header, body);
  const chat = document.getElementById('chat');
  if (chat && j.status === 'negotiating') chat.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

const statusBadgeClass = (s) => ({ done: 'green', no_match: 'red', expired: 'red', cancelled: 'red', pending_confirmation: 'dark', dispatching: 'blue', assigned: 'blue', en_route: 'blue', on_site: 'blue' }[s] ?? '');

// ---- negotiation transcript
function appendChatEvent(chat, e) {
  const d = e.data ?? {};
  if (e.type === 'negotiation.started') {
    chat.append(h('div.sys', {}, `Negoziazione A2A avviata con ${d.participants.length} supplier agent dei partner meglio classificati`));
  } else if (e.type === 'negotiation.buyer_offer') {
    if (d.round && !d.accept_quote) chat.append(h('div.sys', {}, `Round ${d.round}`));
    chat.append(h('div.msg.me', {},
      h('div.avatar', { style: { background: '#000' } }, icon('agent')),
      h('div.bubble', {}, h('div.who', {}, `${e.actor} · buyer agent`), d.message ?? `Offro ${eur(d.offer_cents)}`)));
  } else if (e.type === 'negotiation.supplier_response') {
    const badge = d.action === 'accept' ? h('span.badge.green', {}, 'Accetta') : d.action === 'reject' ? h('span.badge.red', {}, 'Rifiuta') : h('span.badge', {}, 'Controproposta');
    chat.append(h('div.msg', {},
      h('div.avatar', { style: { background: '#545454' } }, d.alias.split(' ').map((p) => p[0]).join('')),
      h('div.bubble', {},
        h('div.who.row', { style: { gap: '6px' } }, `${d.alias} · supplier agent`, badge),
        d.message,
        h('div.row.xs.faint', { style: { marginTop: '4px', gap: '8px' } }, h('b.num', {}, eur(d.price_cents)), h('span', {}, `${d.eta_min} min`), h('span', {}, `★ ${Number(d.rating).toFixed(2)}`), h('span', {}, `match ${d.score}`)))));
  } else if (e.type === 'negotiation.failed') {
    chat.append(h('div.sys', { style: { color: 'var(--danger)' } }, d.message));
  } else if (e.type === 'negotiation.deal') {
    chat.append(h('div.sys', {}, `Accordo a ${eur(d.price_cents)} dopo ${d.rounds} round`));
  }
}

function transcript(j) {
  const chat = h('div.chat', { id: 'chat' });
  for (const e of j.events ?? []) if (e.type.startsWith('negotiation.')) appendChatEvent(chat, e);
  return chat;
}

function viewNegotiating(j) {
  const rounds = (j.events ?? []).filter((e) => e.type === 'negotiation.buyer_offer').length;
  const isConsole = j.agent_name === 'Aronica Buyer Agent';
  const failed = j.status_message && rounds > 0;
  let controls = null;
  if (failed) {
    const cur = j.budget.max_cents ?? 2000;
    controls = h('div.col', {},
      honest(j.status_message, 'Nessun partner accetta entro il tuo budget massimo. Puoi alzare il massimo e rinegoziare.'),
      isConsole ? h('button.btn.primary.block', {
        onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          const newMax = Math.round((cur * 1.25) / 50) * 50;
          await api(`/api/jobs/${j.id}/auto-negotiate?t=${encodeURIComponent(state.token)}`, { method: 'POST', body: { restart: true, max_eur: newMax / 100 } });
          state.job.status_message = null; state.job.events = []; renderJob(false);
        },
      }, `Rinegozia con massimo ${eur(Math.round((cur * 1.25) / 50) * 50)}`) : null);
  } else if (!rounds) {
    controls = h('div.card.flat.small', {}, h('div.searchbar', { style: { marginBottom: '10px' } }),
      isConsole ? 'Il buyer agent sta aprendo la negoziazione…' : `In attesa che ${j.agent_name} invii la prima offerta ai supplier agent…`);
  }
  return h('div.col', { style: { gap: '14px' } },
    h('div.row.between', {}, h('h3', {}, 'Negoziazione live'), h('span.badge', {}, icon('agent'), 'A2A')),
    h('div.small.muted', {}, `Budget: obiettivo ${eur(j.budget.target_cents)} · massimo ${eur(j.budget.max_cents)}`),
    transcript(j),
    controls);
}

// ---- Uber-style confirm
function viewConfirm(j) {
  const d = j.deal;
  let mode = 'now';
  const def = new Date(Date.now() + 2 * 3600000);
  def.setMinutes(Math.ceil(def.getMinutes() / 15) * 15, 0, 0);
  const local = new Date(def.getTime() - def.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const when = h('input.input', { type: 'datetime-local', value: local });
  const whenBox = h('div.hidden', {}, h('label.field', {}, h('span', {}, 'Quando'), when));
  const seg = h('div.seg');
  const drawSeg = () => {
    mount(seg,
      h('button', { class: mode === 'now' ? 'on' : '', onclick: () => { mode = 'now'; drawSeg(); } }, icon('bolt'), ' Adesso'),
      h('button', { class: mode === 'schedule' ? 'on' : '', onclick: () => { mode = 'schedule'; drawSeg(); } }, icon('calendar'), ' Programma'));
    whenBox.classList.toggle('hidden', mode !== 'schedule');
    etaTxt.textContent = mode === 'now' ? `Arrivo stimato in ${d.eta_min} min` : 'Il partner si impegna per l\'orario scelto';
  };
  const etaTxt = h('div.small.muted');
  const countdown = h('span.num');
  const tickCd = () => {
    const s = Math.max(0, Math.round((new Date(d.valid_until).getTime() - Date.now()) / 1000));
    countdown.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (!s) refetch();
  };
  tickCd();
  timers.push(setInterval(tickCd, 1000));
  drawSeg();
  const confirmBtn = h('button.btn.primary.lg.block', {
    onclick: async () => {
      confirmBtn.disabled = true;
      try {
        const body = { mode };
        if (mode === 'schedule') body.scheduled_at = new Date(when.value).toISOString();
        await api(`/api/jobs/${j.id}/confirm?t=${encodeURIComponent(state.token)}`, { method: 'POST', body });
        refetch();
      } catch (e) { toast(e.message, true); confirmBtn.disabled = false; }
    },
  }, `Conferma · ${eur(d.price_cents)}`);
  const lead = d.lead;
  return h('div.col', { style: { gap: '14px' } },
    h('div.card', { style: { boxShadow: 'var(--shadow)' } },
      h('div.row.between', {}, h('h3', {}, 'Accordo pronto'), h('span.xs.faint', {}, `${d.rounds} round di negoziazione`)),
      h('div.row', { style: { margin: '14px 0' } },
        avatar(lead.alias, '#000', lead.kind === 'business' ? 'sq' : ''),
        h('div.grow', {},
          h('div.row', {}, h('b', {}, lead.alias), h('span.badge.green', {}, icon('shield'), 'Verificato')),
          h('div.small.muted.row', { style: { gap: '8px' } }, `★ ${lead.rating.toFixed(2)} (${lead.rating_count})`, '·', VEHICLE_IT[lead.vehicle], '·', `match ${lead.score}`)),
        h('div', { style: { textAlign: 'right' } }, h('div.b-price.num', {}, eur(d.price_cents)))),
      etaTxt,
      h('div.xs.faint', { style: { marginTop: '4px' } }, `Se ${lead.alias} non accetta entro pochi secondi, l'offerta passa automaticamente al prossimo di ${d.pool_size} partner disposti a lavorare a questo prezzo.`),
      h('div.sep'),
      h('dl.kv', {},
        h('dt', {}, 'Compenso partner'), h('dd.num', {}, eur(d.worker_payout_cents)),
        h('dt', {}, 'Commissione Aronica'), h('dd.num', {}, eur(d.platform_fee_cents)),
        h('dt', {}, 'Pagamento'), h('dd', {}, 'Escrow (stub, nessun addebito reale)'),
        h('dt', {}, 'Prova'), h('dd', {}, `${j.proof_requirements.photos_min} foto · GPS ${j.proof_requirements.gps_radius_m} m · ${j.proof_requirements.checklist.length} domande`))),
    seg, whenBox, confirmBtn,
    h('div.row.between.small.muted', {}, h('span', {}, 'Prezzo bloccato per ', countdown), h('button.linkbtn', { onclick: cancelJob }, 'Annulla')),
    h('details', {}, h('summary.small', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Trascrizione della negoziazione'), h('div', { style: { marginTop: '10px' } }, transcript(j))));
}

// ---- dispatch cascade
function viewDispatching(j) {
  const offers = [];
  for (const e of j.events ?? []) {
    if (!e.type.startsWith('dispatch.')) continue;
    if (e.type === 'dispatch.offer_sent') offers.push({ rank: e.data.rank, alias: e.data.alias, sent: e.at, expires: e.data.expires_at, status: 'pending', worker: e.worker_id });
    const o = offers.findLast?.((x) => x.worker === e.worker_id) ?? [...offers].reverse().find((x) => x.worker === e.worker_id);
    if (!o) continue;
    if (e.type === 'dispatch.offer_expired') o.status = 'expired';
    if (e.type === 'dispatch.offer_declined') o.status = 'declined';
    if (e.type === 'dispatch.offer_accepted') o.status = 'accepted';
  }
  const list = h('div');
  const draw = () => mount(list, offers.length ? offers.map((o) => {
    const left = Math.max(0, Math.round((new Date(o.expires).getTime() - Date.now()) / 1000));
    const st = o.status === 'pending' ? h('span.badge.blue', {}, `In attesa · ${left}s`)
      : o.status === 'expired' ? h('span.badge', {}, 'Nessuna risposta')
      : o.status === 'declined' ? h('span.badge', {}, 'Ha rifiutato')
      : h('span.badge.green', {}, 'Accettato');
    return h('div.b-offerrow', {}, h('b.num', {}, `#${o.rank}`), h('span.grow', {}, o.alias), st);
  }) : h('div.small.muted', {}, 'Invio dell\'offerta…'));
  draw();
  timers.push(setInterval(draw, 1000));
  return h('div.col', { style: { gap: '14px' } },
    h('div.b-hero', {}, j.mode === 'schedule' ? `Prenoto una persona per ${dayhhmm(j.scheduled_at)}` : 'Cerco la persona giusta…'),
    h('div.searchbar'),
    h('div.small.muted', {}, `Offerta a tempo al partner con il punteggio più alto; se non risponde passa al successivo. Coda: ${j.dispatch?.pool_size ?? '—'} partner verificati a ${eur(j.deal.price_cents)}.`),
    h('div.card', {}, list),
    h('button.btn.block', { onclick: cancelJob }, 'Annulla richiesta'));
}

// ---- tracking
function etaLine(j) {
  const w = j.worker;
  if (j.status === 'on_site') return `${w.alias} è sul posto`;
  if (j.status === 'assigned' && j.mode === 'schedule') return `${w.alias} confermata per ${dayhhmm(j.scheduled_at)}`;
  if (j.status === 'assigned') return `${w.alias} sta partendo · ${w.eta_min} min`;
  return `${w.alias} arriva in ${Math.max(1, w.eta_min)} min`;
}

function viewTracking(j) {
  const w = j.worker;
  const idx = STEP.indexOf(j.status);
  return h('div.col', { style: { gap: '14px' } },
    h('div.b-hero', { id: 'etaBig' }, etaLine(j)),
    h('div.stepper', {}, STEP.map((s, i) => h('div.s', { class: i < idx ? 'on' : i === idx ? 'now' : '' }))),
    h('div.row.xs.faint.between', {}, h('span', {}, 'Confermato'), h('span', {}, 'Assegnato'), h('span', {}, 'In viaggio'), h('span', {}, 'Sul posto'), h('span', {}, 'Fatto')),
    h('div.card', {},
      h('div.row', {},
        avatar(w.alias, w.avatar_color, w.kind === 'business' ? 'lg sq' : 'lg'),
        h('div.grow', {},
          h('div.row', {}, h('h3', {}, w.alias), w.verified ? h('span.badge.green', {}, icon('shield'), 'Verificato') : null, w.kind === 'business' ? h('span.badge', {}, 'Business') : null),
          h('div.small.muted', {}, `★ ${w.rating?.toFixed(2) ?? 'Nuovo'} (${w.rating_count}) · ${w.jobs_completed} lavori · ${VEHICLE_IT[w.vehicle]}`))),
      j.assigned_via === 'sim' ? h('div.xs.faint', { style: { marginTop: '8px' } }, 'Profilo demo guidato dal simulatore (nessuna persona reale).') : null),
    h('dl.kv', {},
      h('dt', {}, 'Prezzo'), h('dd.num', {}, eur(j.deal.price_cents)),
      h('dt', {}, 'Escrow'), h('dd', {}, j.escrow?.status === 'held' ? 'Trattenuto (stub)' : j.escrow?.status),
      h('dt', {}, 'Scadenza prova'), h('dd', {}, hhmm(j.deadline_at))),
    h('button.btn.block', { onclick: cancelJob }, j.status === 'assigned' ? 'Annulla (gratis)' : 'Annulla (penale 30%)'));
}

// ---- done
function viewDone(j) {
  const p = j.proof;
  const req = j.proof_requirements;
  const q = Object.fromEntries(req.checklist.map((c) => [c.id, c.q]));
  const fmtAns = (v) => (v === 'yes' ? 'Sì' : v === 'no' ? 'No' : String(v));
  return h('div.col', { style: { gap: '14px' } },
    h('div.row', {}, h('div.b-hero', {}, 'Fatto'), h('span.badge.green', {}, icon('check'), 'Prova verificata')),
    p.simulated ? h('div.card.flat.small', {}, icon('info'), ' Prova prodotta dal simulatore demo (persona seed). Con un partner reale qui vedi le sue foto.') : null,
    h('div.photos', {}, p.photos.map((src) => h('img', { src, alt: 'Foto prova', onclick: () => lightbox(src), style: { cursor: 'zoom-in' } }))),
    h('div.req', {},
      h('span.badge.green', {}, icon('camera'), `${p.photos.length}/${req.photos_min} foto`),
      h('span.badge.green', {}, icon('pin'), `GPS a ${p.gps.distance_m} m (max ${p.gps.radius_m})${p.gps.simulated_position ? ' · simulato' : ''}`),
      h('span.badge.green', {}, icon('clock'), `Consegnata ${hhmm(p.submitted_at)}`)),
    h('div.card', {}, h('dl.kv', {}, Object.entries(p.answers).flatMap(([k, v]) => [h('dt', {}, q[k] ?? k), h('dd', {}, fmtAns(v))]))),
    h('dl.kv', {},
      h('dt', {}, 'Partner'), h('dd', {}, j.worker.alias),
      h('dt', {}, 'Pagato'), h('dd.num', {}, eur(j.deal.price_cents)),
      h('dt', {}, 'Escrow'), h('dd', {}, 'Rilasciato (stub)')),
    j.buyer_rating ? h('div.card.flat', {}, `Hai valutato ${j.worker.alias}: ★ ${j.buyer_rating}`) : ratingWidget(j));
}

function ratingWidget(j) {
  let stars = 0;
  const tags = new Set();
  const starsBox = h('div.stars');
  const tagBox = h('div.chips');
  const comment = h('input.input', { placeholder: 'Commento (facoltativo)' });
  const draw = () => {
    mount(starsBox, [1, 2, 3, 4, 5].map((n) => h('button.star-btn', { class: n <= stars ? 'on' : '', onclick: () => { stars = n; tags.clear(); draw(); } }, icon('star'))));
    const pos = stars >= 4;
    mount(tagBox, stars ? Object.entries(cfg.rating_tags).filter(([, t]) => t.positive === pos).map(([k, t]) =>
      h('button.chip', { class: tags.has(k) ? 'on' : '', onclick: () => { tags.has(k) ? tags.delete(k) : tags.add(k); draw(); } }, t.label_it + (t.excluded ? ' (non conta)' : ''))) : []);
  };
  draw();
  return h('div.card', {},
    h('h3', {}, `Com'è andata con ${j.worker.alias}?`),
    h('div.xs.faint', { style: { margin: '4px 0 8px' } }, 'Le valutazioni proteggono gli altri clienti: sotto soglia un partner riceve un avviso, poi viene sospeso. Se il problema non dipendeva da lui, scegli un motivo "non conta".'),
    starsBox, tagBox, h('div', { style: { marginTop: '10px' } }, comment),
    h('button.btn.primary.block', {
      style: { marginTop: '10px' },
      onclick: async () => {
        if (!stars) return toast('Scegli da 1 a 5 stelle', true);
        try {
          await api(`/api/jobs/${j.id}/rating?t=${encodeURIComponent(state.token)}`, { method: 'POST', body: { stars, tags: [...tags], comment: comment.value } });
          toast('Grazie per la valutazione');
          refetch();
        } catch (e) { toast(e.message, true); }
      },
    }, 'Invia valutazione'));
}

function viewClosed(j) {
  const title = { no_match: 'Nessuna persona disponibile', expired: 'Scaduto', cancelled: 'Annullato' }[j.status] ?? j.status_label;
  return h('div.col', { style: { gap: '14px' } },
    honest(j.status_message || title, j.escrow ? `Escrow: ${j.escrow.status}${j.escrow.cancel_fee_cents ? ` · penale ${eur(j.escrow.cancel_fee_cents)}` : ''}` : null),
    h('a.btn.primary.block', { href: '#/' }, 'Nuova richiesta'),
    (j.events ?? []).some((e) => e.type.startsWith('negotiation.')) ? h('details', {}, h('summary.small', {}, 'Trascrizione'), transcript(j)) : null);
}

async function cancelJob() {
  if (!confirm('Annullare la richiesta?')) return;
  try {
    await api(`/api/jobs/${state.job.id}/cancel?t=${encodeURIComponent(state.token)}`, { method: 'POST', body: {} });
    refetch();
  } catch (e) { toast(e.message, true); }
}

// ---- map
function drawJobMap(animate, refit = true) {
  const j = state.job;
  const loc = j.location;
  map.set('task', { lat: loc.lat, lng: loc.lng, html: taskPin(j.status === 'done' ? 'Fatto' : j.skill_name, { done: j.status === 'done', pulse: j.status === 'dispatching' }) });
  if (j.worker && ['assigned', 'en_route', 'on_site', 'done'].includes(j.status)) {
    const p = j.worker.position;
    map.set('worker', { lat: p.lat, lng: p.lng, html: workerPin(j.worker.alias, j.worker.avatar_color, { label: j.status === 'en_route' ? `${Math.max(1, j.worker.eta_min)} min` : null }), z: 500, animate });
    if (['assigned', 'en_route'].includes(j.status)) map.line('route', [p, loc], { weight: 4 }); else map.line('route', null);
    if (!animate && refit) map.fit([p, loc], 80);
  } else {
    map.remove('worker'); map.line('route', null);
    if (refit) map.view(loc, 15);
  }
}

// ------------------------------------------------------------------ boot
(async () => {
  cfg = await api('/api/config');
  map = createMap(document.getElementById('map'), { zoom: 13, onClick: (p) => map.onPick?.(p) });
  window.addEventListener('hashchange', route);
  route();
})();
