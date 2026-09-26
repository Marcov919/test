// Aronica Partner — worker / business app. Uber-Driver-style: map first, big GO
// button, full-screen timed offers with Accetto / Rifiuto, guided proof capture.
import {
  h, mount, api, sse, eur, pct, hhmm, dayhhmm, deadlineText, toast, icon, avatar, vehicleIcon, VEHICLE_IT,
  ring, createMap, taskPin, mePin, twoStep, serverNow, setClockOffset,
} from '/shared/common.js';

let root;
let demo = false;
const $r = (sel) => root.querySelector(sel);
const TOKEN_KEY = 'aronica.worker_token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* private mode */ }

let cfg = null;
let me = null;          // /partner/v1/me payload
let map = null;
let es = null;
let offerTimer = null;
let shownOffer = null;
let overlay = null;     // current overlay element
let focusJobId = null;  // for businesses with several active jobs
let pollTimer = null;
let doneShown = new Set();

const hdr = () => ({ 'X-Worker-Token': token });
const wapi = (path, opts = {}) => api(path, { ...opts, headers: { ...hdr(), ...(opts.headers ?? {}) } });

// ------------------------------------------------------------------ boot
export const phoneBusy = () => !!(shownOffer || me?.active_jobs?.length);

export async function mountWorker(el, { autoLogin = null, demo: isDemo = false, token: tk = null } = {}) {
  root = el;
  demo = isDemo;
  if (tk) { token = tk; es?.close(); clearInterval(pollTimer); root.replaceChildren(); map = null; shownOffer = null; closeOverlay(); }
  cfg = await api('/api/config');
  setClockOffset(cfg.clock_offset_ms);
  if (!token && autoLogin) {
    try {
      token = (await api('/partner/v1/login', { method: 'POST', body: { worker_id: autoLogin } })).token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* */ }
    } catch { /* fall through to the picker */ }
  }
  if (!token) return renderLogin();
  try {
    await refresh();
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    throw e;
  }
  connect();
}

function connect() {
  es?.close();
  es = sse(`/partner/v1/stream?wt=${encodeURIComponent(token)}`, onEvent);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh().catch(() => {}), 8000);
}

let refreshQueued = null;
function refreshSoon() {
  clearTimeout(refreshQueued);
  refreshQueued = setTimeout(() => refresh().catch(() => {}), 150);
}

async function refresh() {
  me = await wapi('/partner/v1/me');
  me.active_jobs = me.active_jobs.map((j) => ({
    ...j, job_status: j.status, status: j.assignment.status, status_label: j.assignment.status_label,
    skill_name: j.service_name, contract: j.assignment.contract, crew: j.assignment.crew,
  }));
  renderApp();
  const offer = me.offers[0];
  if (offer && (!shownOffer || shownOffer.offer_id !== offer.offer_id)) showOffer(offer);
  if (!offer && shownOffer) closeOffer();
}

function onEvent(e) {
  if (e.type === 'worker.location' && me) {
    me.worker.lat = e.data.lat; me.worker.lng = e.data.lng;
    const j = me.active_jobs.find((x) => x.id === e.job_id);
    if (j) { j._remaining_m = e.data.remaining_m; j._eta = e.data.eta_min; j._inside = e.data.within_geofence; }
    drawMap(true);
    updateLiveBits();
    return;
  }
  if (e.type === 'clock.changed') { setClockOffset(e.data.offset_ms); refreshSoon(); return; }
  if (e.type === 'dispatch.offer_sent') {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    showOffer(e.data);
  }
  if (e.type === 'dispatch.offer_expired' && shownOffer) {
    closeOffer();
    toast('Offerta scaduta: passata al prossimo partner');
  }
  if (e.type === 'assignment.done' && e.worker_id === me?.worker.id && !doneShown.has(e.job_id)) {
    doneShown.add(e.job_id);
    showDone(e.data.payout_cents, e.job_id);
  }
  if (e.type === 'job.cancelled') toast('Il cliente ha annullato il lavoro');
  if (e.type === 'worker.tier_changed') toast(`Affidabilità aggiornata: ${tierLabel(e.data.to)}`);
  refreshSoon();
}

function logout() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* */ }
  token = null; me = null; es?.close(); clearInterval(pollTimer);
  map = null;
  renderLogin();
}

// ------------------------------------------------------------------ login / signup
async function renderLogin() {
  const people = await api('/partner/v1/demo-profiles');
  const pick = async (id) => {
    const r = await api('/partner/v1/login', { method: 'POST', body: { worker_id: id } });
    token = r.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* */ }
    root.replaceChildren();
    map = null;
    await refresh();
    connect();
  };
  const statusBadge = (w) => w.status === 'suspended' ? h('span.badge.red', {}, 'Sospeso')
    : w.status === 'pending_verification' ? h('span.badge.blue', {}, 'In verifica')
    : w.tier === 'warning' ? h('span.badge.warn', {}, 'Attenzione')
    : w.online ? h('span.badge.green', {}, 'Online') : h('span.badge', {}, 'Offline');
  const card = (w) => h('div.item.clickable', { onclick: () => pick(w.id), style: { padding: '12px', borderRadius: '12px' } },
    avatar(w.display_name, w.avatar_color, w.kind === 'business' ? 'sq' : ''),
    h('div.grow', {},
      h('div.row', {}, h('b', {}, w.display_name), w.kind === 'business' ? h('span.badge', {}, 'Business') : null),
      h('div.small.muted', {}, `${w.zone} · ${w.skills.slice(0, 3).map((c) => cfg?.services.find((x) => x.code === c)?.name_it ?? c).join(', ')}${w.skills.length > 3 ? '…' : ''}`)),
    statusBadge(w), icon('chevron'));
  mount(root, h('div.w-login', {}, h('div.inner', {},
    h('div.row.between', {}, h('span.logo', {}, h('i'), 'Aronica ', h('span.faint', { style: { fontWeight: 600 } }, 'Partner')), demo ? null : h('a.small.muted', { href: '/' }, 'Home')),
    h('div', {}, h('h1', {}, 'Lavora quando vuoi, a Milano.'), h('p.muted', {}, 'Ricevi incarichi già strutturati: scadenza, istruzioni, compenso e prova richiesta. Tu scegli: Accetto o Rifiuto.')),
    h('button.btn.primary.lg.block', { onclick: renderSignup }, 'Registrati come persona o attività'),
    h('div.sep'),
    h('div', {}, h('h3', {}, 'Accesso demo'), h('p.small.muted', {}, 'v1 non invia SMS: scegli un profilo seed per entrare. In produzione: login con OTP sul telefono.')),
    h('div.list', {}, people.filter((w) => w.kind === 'person').map(card)),
    h('h3', {}, 'Attività'),
    h('div.list', {}, people.filter((w) => w.kind === 'business').map(card)),
  )));
}

function renderSignup() {
  let kind = 'person';
  const skills = new Set();
  const form = h('div.col', { style: { gap: '14px' } });
  const FIELDS = ['su_name', 'su_legal', 'su_vat', 'su_cap', 'su_zone', 'su_vehicle'];
  const vals = {};
  const draw = () => {
    // keep typed values across re-renders (toggling chips / kind)
    for (const k of FIELDS) { const el = $r(`#${k}`); if (el) vals[k] = el.value; }
    mount(form,
      h('div.seg', {},
        h('button', { class: kind === 'person' ? 'on' : '', onclick: () => { kind = 'person'; draw(); } }, 'Persona'),
        h('button', { class: kind === 'business' ? 'on' : '', onclick: () => { kind = 'business'; draw(); } }, 'Attività / Business')),
      h('label.field', {}, h('span', {}, kind === 'business' ? 'Nome dell\'attività' : 'Nome e iniziale del cognome'),
        h('input.input', { id: 'su_name', placeholder: kind === 'business' ? 'Es. FotoPunto Srl' : 'Es. Laura T.', maxlength: 60 })),
      kind === 'business' ? h('label.field', {}, h('span', {}, 'Ragione sociale'), h('input.input', { id: 'su_legal', placeholder: 'Es. FotoPunto S.r.l.' })) : null,
      kind === 'business' ? h('label.field', {}, h('span', {}, 'Partita IVA'), h('input.input', { id: 'su_vat', placeholder: 'IT01234567890' })) : null,
      kind === 'business' ? h('label.field', {}, h('span', {}, 'Operatori disponibili in contemporanea'), h('input.input', { id: 'su_cap', type: 'number', min: 1, max: 20, value: 2 })) : null,
      h('label.field', {}, h('span', {}, 'Zona di partenza'),
        h('select.input', { id: 'su_zone' }, cfg.places.map((p) => h('option', { value: p.name }, p.name)))),
      h('label.field', {}, h('span', {}, 'Mezzo'),
        h('select.input', { id: 'su_vehicle' }, Object.entries(VEHICLE_IT).map(([k, v]) => h('option', { value: k, selected: k === 'bike' }, v)))),
      h('div.field', {}, h('span', {}, 'Servizi che offri'),
        h('div.chips', {}, cfg.services.map((s) => h('button.chip', {
          class: skills.has(s.code) ? 'on' : '',
          onclick: () => { skills.has(s.code) ? skills.delete(s.code) : skills.add(s.code); draw(); },
        }, s.name_it)))),
      h('div.card.flat.small.muted', {}, icon('shield'), ' Dopo la registrazione il tuo account resta "in verifica": documento d\'identità (persone) o visura/P.IVA (attività). Solo profili verificati ricevono offerte.'),
      h('button.btn.primary.lg.block', { onclick: submit }, 'Crea account'),
      h('button.btn.ghost.block', { onclick: renderLogin }, 'Indietro'),
    );
    for (const k of FIELDS) { const el = form.querySelector(`#${k}`); if (el && vals[k] != null) el.value = vals[k]; }
  };
  const submit = async () => {
    const v = (id) => $r(`#${id}`)?.value;
    try {
      const r = await api('/partner/v1/signup', {
        method: 'POST',
        body: { kind, display_name: v('su_name'), legal_name: v('su_legal'), vat_id: v('su_vat'), capacity: Number(v('su_cap') || 1), zone: v('su_zone'), vehicle: v('su_vehicle'), skills: [...skills] },
      });
      token = r.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* */ }
      root.replaceChildren(); map = null;
      await refresh(); connect();
    } catch (e) { toast(e.message, true); }
  };
  draw();
  mount(root, h('div.w-login', {}, h('div.inner', {}, h('span.logo', {}, h('i'), 'Aronica Partner'), h('h1', {}, 'Registrazione'), form)));
}

// ------------------------------------------------------------------ main app
const tierLabel = (t) => ({ good: 'Ottima', warning: 'Attenzione', suspended: 'Sospeso' }[t] ?? t);

function currentJob() {
  if (!me?.active_jobs.length) return null;
  return me.active_jobs.find((j) => j.id === focusJobId) ?? me.active_jobs[0];
}

function renderApp() {
  if (!root.querySelector('.w-app')) {
    root.replaceChildren(h('div.w-app', {},
      h('div.map', { id: 'map' }),
      h('div.w-top', { id: 'top' }),
      h('div', { id: 'go' }),
      h('section.w-sheet', { id: 'sheet' })));
    map = createMap($r('#map'), { dark: true, zoom: 14, center: { lat: me.worker.lat, lng: me.worker.lng } });
  }
  renderTop();
  renderSheet();
  drawMap(false);
}

function renderTop() {
  const w = me.worker;
  mount($r('#top'),
    h('button.w-iconbtn', { onclick: showProfile, title: 'Profilo' }, icon('menu')),
    h('button.w-pill.num', { onclick: showProfile }, h('small', {}, 'Guadagni'), eur(w.earnings_cents)),
    h('button.w-iconbtn', { onclick: showProfile, style: { background: w.avatar_color, color: '#fff', fontWeight: 800 } }, w.display_name.split(' ').map((p) => p[0]).join('').slice(0, 2)));
}

function sheetHeight() {
  return $r('#sheet')?.offsetHeight ?? 200;
}

function renderSheet() {
  const w = me.worker;
  const sheet = $r('#sheet');
  const go = $r('#go');
  mount(go);
  const job = currentJob();
  const banners = [];
  if (w.status === 'active' && me.reliability.tier === 'warning') {
    banners.push(h('div.w-banner.warn', {}, icon('alert'), h('div', {}, h('b', {}, 'Attenzione all\'affidabilità. '), me.reliability.reasons.join(' · '), '. Ricevi meno offerte e niente lavori oltre €50 finché non migliori.')));
  }
  if (w.simulated) {
    banners.push(h('div.xs.faint', {}, 'Profilo demo: quando chiudi l\'app, il simulatore può rispondere per questo profilo.'));
  }

  if (w.status === 'pending_verification') {
    return mount(sheet,
      h('h2', {}, 'Account in verifica'),
      h('p.muted', {}, w.kind === 'business' ? 'Stiamo verificando visura camerale e Partita IVA.' : 'Stiamo verificando documento d\'identità e selfie.'),
      h('div.w-banner.blue', {}, icon('shield'), h('div', {}, 'Niente "registrazione teatro": solo profili verificati ricevono lavori. In questa demo la verifica la fa l\'operatore in ', demo ? 'Ops (scheda in alto)' : h('a', { href: '/ops', target: '_blank' }, 'Ops'), '.')),
      h('div.sep'), h('button.btn.block', { onclick: logout }, 'Esci'));
  }
  if (w.status === 'suspended') {
    return mount(sheet,
      h('h2', {}, 'Account sospeso'),
      h('div.w-banner.red', {}, icon('alert'), h('div', {}, h('b', {}, 'Motivi: '), (w.tier_reasons.length ? w.tier_reasons : me.reliability.reasons).join(' · '))),
      h('p.small.muted', {}, 'Come su Uber, la sospensione arriva dopo un avviso e scatta sotto soglie precise di valutazione, completamento o mancate presenze. Puoi chiedere una revisione: il team Ops può riattivarti.'),
      h('button.btn.block', { onclick: showProfile }, 'Vedi dettagli affidabilità'),
      h('button.btn.ghost.block', { onclick: logout }, 'Esci'));
  }

  if (job) return mount(sheet, ...banners, renderJobSheet(job));

  if (!w.online) {
    mount(go, h('button.w-go', { onclick: () => setOnline(true), style: { bottom: '0px' } }, 'VAI'));
    mount(sheet,
      h('div.row.between', {}, h('h2', {}, 'Sei offline'), h('span.badge', {}, w.zone)),
      h('p.muted', { style: { marginTop: '4px' } }, 'Vai online per ricevere offerte di lavoro vicino a te.'),
      ...banners,
      statsStrip());
    requestAnimationFrame(() => { const b = go.firstChild; if (b) b.style.bottom = `${sheetHeight() + 18}px`; });
    return;
  }
  mount(sheet,
    h('div.row.between', {},
      h('div', {}, h('h2', {}, 'Sei online'), h('div.small.muted', {}, `Cerchiamo lavori vicino a ${w.zone}…`)),
      h('button.btn.sm', { onclick: () => setOnline(false) }, icon('power'), 'Offline')),
    h('div.searchbar', { style: { margin: '14px 0' } }),
    ...banners,
    w.kind === 'business' ? h('div.small.muted', {}, `Capacità: ${me.active_jobs.length}/${w.capacity} operatori impegnati`) : null,
    statsStrip());
}

function statsStrip() {
  const r = me.reliability;
  return h('div.grid3', { style: { marginTop: '12px' } },
    h('div.stat', {}, h('b.num', {}, r.rating.raw_avg != null ? r.rating.raw_avg.toFixed(2) : 'Nuovo'), h('span', {}, `Valutazione (${r.rating.count})`)),
    h('div.stat', {}, h('b.num', {}, pct(r.completion)), h('span', {}, 'Completamento')),
    h('div.stat', {}, h('b.num', {}, pct(r.acceptance)), h('span', {}, 'Accettazione')));
}

async function setOnline(v) {
  try {
    await wapi('/partner/v1/online', { method: 'POST', body: { online: v } });
    await refresh();
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ map
function drawMap(animate) {
  if (!map || !me) return;
  const w = me.worker;
  map.set('me', { lat: w.lat, lng: w.lng, html: mePin(), z: 1000, animate });
  const ids = new Set(me.active_jobs.map((j) => `job:${j.id}`));
  for (const j of me.active_jobs) {
    map.set(`job:${j.id}`, { lat: j.location.lat, lng: j.location.lng, html: taskPin(j.skill_name) });
  }
  // stale job pins
  for (const j of me.history ?? []) if (!ids.has(`job:${j.id}`)) map.remove(`job:${j.id}`);
  const job = currentJob();
  if (job && ['assigned', 'en_route'].includes(job.status)) {
    map.line('route', [{ lat: w.lat, lng: w.lng }, job.location], { color: '#276ef1', weight: 5 });
  } else map.line('route', null);
  if (!animate) {
    if (job) map.fit([{ lat: w.lat, lng: w.lng }, job.location], 90);
    else map.view({ lat: w.lat, lng: w.lng }, 14);
  }
}

// ------------------------------------------------------------------ offers
function showOffer(o) {
  shownOffer = o;
  clearInterval(offerTimer);
  const exp = new Date(o.expires_at).getTime();
  const ringBox = h('div');
  const tickRing = () => {
    const left = (exp - serverNow()) / 1000;
    mount(ringBox, ring(left, o.ttl_s, 68));
    if (left <= 0) { closeOffer(); toast('Offerta scaduta'); }
  };
  const answer = async (accept, btn) => {
    btn.disabled = true;
    try {
      await wapi(`/partner/v1/offers/${o.offer_id}/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
      closeOffer();
      if (accept) { focusJobId = o.job_id; toast('Lavoro accettato: trovi il contratto nei dettagli'); }
      await refresh();
    } catch (e) { toast(e.message, true); closeOffer(); refresh(); }
  };
  const p = o.proof;
  const panel = h('div.panel', {},
    h('div.row.between', { style: { alignItems: 'flex-start' } },
      h('div', {},
        h('div.row', { style: { gap: '6px' } }, h('span.badge.blue', {}, o.service_name), o.segment === 'business' ? h('span.badge', {}, 'Azienda') : h('span.badge', {}, 'Privato')),
        h('div.offer-pay.num', { style: { marginTop: '10px' } }, eur(o.pay_cents)),
        h('div.small.muted', {}, o.seats > 1 ? `Compenso per ${o.seats} persone della tua squadra` : 'Compenso netto per te')),
      ringBox),
    h('div.offer-meta', { style: { margin: '14px 0' } },
      h('span', {}, icon('calendar'), o.slot_label),
      h('span', {}, icon('route'), `${String(o.distance_km).replace('.', ',')} km`),
      o.headcount > 1 ? h('span', {}, icon('user'), o.seats > 1 ? `${o.seats} posti su ${o.headcount}` : `1 posto su ${o.headcount}`) : null),
    h('h3', {}, o.title),
    h('div.row.small.muted', { style: { marginTop: '4px' } }, icon('pin'), o.address),
    h('div.sep'),
    h('div.xs.faint', { style: { textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 } }, 'Istruzioni'),
    h('ol.steps-list', { style: { margin: '8px 0 12px' } }, o.instructions.map((s) => h('li', {}, s))),
    h('div.xs.faint', { style: { textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 } }, 'Prova richiesta'),
    h('div.req', { style: { margin: '8px 0 16px' } },
      ...proofBadges(p)),
    h('div.small.faint', { style: { marginBottom: '12px' } }, `Richiesto da ${o.buyer} · offerta #${o.rank} in coda`),
    h('div.row', {},
      h('button.btn.lg', { style: { flex: '1' }, onclick: (e) => answer(false, e.currentTarget) }, 'Rifiuto'),
      h('button.btn.lg.go', { style: { flex: '2' }, onclick: (e) => answer(true, e.currentTarget) }, 'Accetto')));
  openOverlay(h('div.w-overlay', {}, panel), 'offer');
  tickRing();
  offerTimer = setInterval(tickRing, 250);
}

function proofBadges(p) {
  return p.kind === 'timesheet'
    ? [h('span.badge', {}, icon('clock'), 'Check-in e check-out'), h('span.badge', {}, icon('pin'), `GPS entro ${p.gps_radius_m} m`)]
    : [h('span.badge', {}, icon('camera'), p.shots?.length ? `Foto: ${p.shots.join(' · ')}` : `${p.photos_min} foto`), h('span.badge', {}, icon('pin'), `GPS entro ${p.gps_radius_m} m`), h('span.badge', {}, icon('list'), `${p.checklist.length} domande`)];
}

function closeOffer() {
  clearInterval(offerTimer);
  shownOffer = null;
  if (overlay?.dataset.kind === 'offer') closeOverlay();
}

function openOverlay(el, kind) {
  closeOverlay();
  el.dataset.kind = kind;
  overlay = el;
  root.append(el);
}
function closeOverlay() {
  overlay?.remove();
  overlay = null;
}

// ------------------------------------------------------------------ active job
const STEPS = ['assigned', 'en_route', 'on_site', 'done'];

function renderJobSheet(job) {
  const idx = STEPS.indexOf(job.status);
  const w = me.worker;
  const dist = job._remaining_m ?? Math.round(haversine(w, job.location));
  const inside = dist <= job.proof_requirements.gps_radius_m;
  const timesheet = job.proof_requirements.kind === 'timesheet';
  const startsIn = Math.round((new Date(job.slot?.start).getTime() - serverNow()) / 60000);
  const act = async (action, body) => {
    try { await wapi(`/partner/v1/jobs/${job.id}/${action}`, { method: 'POST', body }); await refresh(); } catch (e) { toast(e.message, true); }
  };
  let primary;
  if (job.status === 'assigned') {
    primary = h('div.col', { style: { gap: '6px' } },
      h('button.btn.primary.lg.block', { onclick: () => act('start') }, icon('route'), startsIn > 90 ? 'Parti ora (in anticipo)' : 'Sto partendo'),
      startsIn > 90 ? h('div.xs.faint.center', {}, `Inizia tra ${startsIn > 1440 ? `${Math.round(startsIn / 1440)} giorni` : `${Math.round(startsIn / 60)} ore`}. Demo: puoi partire subito, oppure avanza l'orologio in Ops.`) : null);
  } else if (job.status === 'en_route') {
    primary = h('button.btn.primary.lg.block', { id: 'arriveBtn', disabled: !inside, onclick: () => act('arrive') },
      icon('pin'), inside ? (timesheet ? 'Check-in: sono arrivato' : 'Sono arrivato') : `Mancano ${fmtDist(dist)}`);
  } else if (job.status === 'on_site') {
    primary = timesheet
      ? h('button.btn.go.lg.block', { onclick: () => showProof(job) }, icon('clock'), 'Termina turno · check-out')
      : h('button.btn.go.lg.block', { onclick: () => showProof(job) }, icon('camera'), 'Carica la prova');
  }
  const tabs = me.active_jobs.length > 1
    ? h('div.chips', { style: { marginBottom: '10px' } }, me.active_jobs.map((j, i) => h('button.chip', { class: j.id === job.id ? 'on' : '', onclick: () => { focusJobId = j.id; renderApp(); } }, `Lavoro ${i + 1} · ${j.status_label}`)))
    : null;
  return h('div', {},
    tabs,
    h('div.stepper', {}, STEPS.map((s, i) => h('div.s', { class: i < idx ? 'on' : i === idx ? 'now' : '' }))),
    h('div.row.between', { style: { marginTop: '12px' } },
      h('div', {}, h('div.small.muted', {}, job.status_label), h('h2', {}, job.title)),
      h('div', { style: { textAlign: 'right' } }, h('div.num', { style: { fontWeight: 800, fontSize: '22px' } }, eur(job.pay_cents)), h('div.xs.faint', {}, 'compenso'))),
    h('div.row.small.muted', { style: { margin: '8px 0' } }, icon('pin'), job.location.address),
    h('div.row.small.wrap', { style: { marginBottom: '12px', gap: '10px' } },
      h('span.row', {}, icon('calendar'), job.slot?.label ?? job.window.label),
      job.headcount > 1 ? h('span.badge', {}, `${job.crew > 1 ? `${job.crew} posti` : '1 posto'} su ${job.headcount}`) : null,
      job.contract ? h('span.badge.blue', {}, job.contract.label) : null,
      job.status === 'en_route' ? h('span.row', { id: 'liveDist' }, icon('route'), fmtDist(dist)) : null),
    job.status === 'en_route' ? h('div.xs.faint', { style: { marginBottom: '8px' } }, w.real_gps ? 'GPS reale del dispositivo' : 'Navigazione simulata (demo): la posizione si muove verso il luogo') : null,
    primary,
    h('details', { style: { marginTop: '14px' } },
      h('summary.small', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Istruzioni e prova richiesta'),
      h('ol.steps-list', { style: { margin: '10px 0' } }, job.instructions.map((s) => h('li.small', {}, s))),
      h('div.req', {}, ...proofBadges(job.proof_requirements)),
      job.contract ? h('pre.small', { style: { whiteSpace: 'pre-wrap', background: 'var(--bg-2)', padding: '10px', borderRadius: '10px', marginTop: '10px', fontFamily: 'inherit' } }, job.contract.text) : null),
    ['assigned', 'en_route'].includes(job.status)
      ? h('div.center', { style: { marginTop: '14px' } }, h('button.linkbtn', {
        onclick: twoStep('Tocca di nuovo: il lavoro torna in coda e peggiora il tuo tasso di cancellazione', () => act('cancel', { reason: 'worker_cancel' })),
      }, 'Non posso più farlo'))
      : null);
}

function updateLiveBits() {
  const job = currentJob();
  if (!job || job.status !== 'en_route') return;
  const dist = job._remaining_m ?? 0;
  const el = $r('#liveDist');
  if (el) mount(el, icon('route'), fmtDist(dist));
  const btn = $r('#arriveBtn');
  if (btn) {
    const inside = dist <= job.proof_requirements.gps_radius_m;
    btn.disabled = !inside;
    mount(btn, icon('pin'), inside ? 'Sono arrivato' : `Mancano ${fmtDist(dist)}`);
  }
}

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`);
function haversine(a, b) {
  const R = 6371000; const r = (d) => (d * Math.PI) / 180;
  const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ------------------------------------------------------------------ proof
async function fileToDataUrl(file) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i); i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
  const max = 1024; // keeps a 4-6 photo proof well under the host's ~4.5 MB body limit
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c.toDataURL('image/jpeg', 0.78);
}

function showProof(job) {
  const req = job.proof_requirements;
  const photos = [];
  const answers = {};
  const grid = h('div.photos');
  const fileIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, style: { display: 'none' } });
  const drawPhotos = () => {
    mount(grid,
      photos.map((p, i) => h('div', { style: { position: 'relative' } }, h('img', { src: p, alt: req.shots?.[i] ?? `Foto ${i + 1}` }),
        req.shots?.[i] ? h('span.xs', { style: { position: 'absolute', left: '4px', bottom: '4px', background: 'rgba(0,0,0,.65)', color: '#fff', padding: '1px 6px', borderRadius: '6px' } }, req.shots[i]) : null,
        h('button.btn.sm', { style: { position: 'absolute', top: '4px', right: '4px', padding: '4px' }, onclick: () => { photos.splice(i, 1); drawPhotos(); } }, icon('x')))),
      h('div.slot', { onclick: () => fileIn.click() }, h('div.center', {}, icon('camera'), h('div.xs', {}, req.shots?.[photos.length] ?? 'Scatta'))));
    counter.textContent = `${photos.length}/${req.photos_min} foto`;
    counter.className = photos.length >= req.photos_min ? 'badge green' : 'badge';
  };
  const counter = h('span.badge');
  fileIn.addEventListener('change', async () => {
    for (const f of fileIn.files) {
      try { photos.push(await fileToDataUrl(f)); } catch { toast('Immagine non leggibile', true); }
    }
    fileIn.value = '';
    drawPhotos();
  });
  const q = (item) => {
    if (item.type === 'yes_no') {
      const box = h('div.yn');
      const draw = () => mount(box, ['yes', 'no'].map((v) => h('button.btn', {
        class: answers[item.id] === v ? 'primary' : '', onclick: () => { answers[item.id] = v; draw(); },
      }, v === 'yes' ? 'Sì' : 'No')));
      draw();
      return h('div.field', {}, h('span', {}, item.q + (item.required ? ' *' : '')), box);
    }
    return h('label.field', {}, h('span', {}, item.q + (item.required ? ' *' : '')),
      item.type === 'number'
        ? h('input.input', { inputmode: 'decimal', oninput: (e) => { answers[item.id] = e.target.value; } })
        : h('textarea.input', { rows: 2, oninput: (e) => { answers[item.id] = e.target.value; } }));
  };
  const errors = h('div');
  const submit = async (btn) => {
    btn.disabled = true;
    mount(errors);
    try {
      const r = await wapi(`/partner/v1/jobs/${job.id}/proof`, { method: 'POST', body: { photos, answers } });
      // job.done may already have arrived over SSE; show the payout screen once.
      if (!doneShown.has(job.id)) { doneShown.add(job.id); showDone(r.payout_cents, job.id); }
      await refresh();
    } catch (e) {
      const probs = e.data?.problems ?? [e.message];
      mount(errors, h('div.w-banner.red', {}, icon('alert'), h('div', {}, h('b', {}, 'Prova non accettata'), h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, probs.map((p) => h('li', {}, p))))));
      btn.disabled = false;
    }
  };
  const timesheet = req.kind === 'timesheet';
  const checkIn = job.assignment?.arrived_at ? new Date(job.assignment.arrived_at).getTime() : null;
  const worked = checkIn ? Math.max(0, Math.round((serverNow() - checkIn) / 60000)) : 0;
  const panel = h('div.panel', {},
    h('div.row.between', {}, h('button.w-iconbtn', { onclick: closeOverlay, style: { boxShadow: 'none', background: 'var(--bg-2)' } }, icon('back')), h('b', {}, timesheet ? 'Fine turno' : 'Prova'), h('span', { style: { width: '46px' } })),
    h('h2', { style: { margin: '14px 0 4px' } }, job.title),
    h('div.small.muted', {}, timesheet
      ? 'Il check-out registra l\'orario e la posizione: le ore lavorate finiscono nel contratto e nel pagamento.'
      : 'La prova viene verificata automaticamente: numero di foto, posizione GPS, orario e risposte.'),
    timesheet ? h('div.grid2', { style: { margin: '16px 0' } },
      h('div.stat', {}, h('b.num', {}, checkIn ? hhmm(job.assignment.arrived_at) : '—'), h('span', {}, 'Check-in')),
      h('div.stat', {}, h('b.num', {}, `${Math.floor(worked / 60)}h ${worked % 60}m`), h('span', {}, `Lavorate (previste ${job.duration_label})`))) : null,
    timesheet ? null : h('div.row.between', { style: { margin: '18px 0 8px' } }, h('h3', {}, 'Foto'), counter),
    timesheet ? null : grid, fileIn,
    h('h3', { style: { margin: '18px 0 8px' } }, timesheet ? 'Note' : 'Checklist'),
    h('div.col', { style: { gap: '14px' } }, req.checklist.map(q)),
    h('div.req', { style: { margin: '16px 0' } },
      h('span.badge.green', {}, icon('pin'), 'Posizione rilevata sul posto'),
      h('span.badge', {}, icon('calendar'), job.slot?.label ?? '')),
    errors,
    h('button.btn.go.lg.block', { style: { marginTop: '10px' }, onclick: (e) => submit(e.currentTarget) }, timesheet ? 'Check-out' : 'Invia prova'));
  drawPhotos();
  openOverlay(h('div.w-overlay.full', {}, panel), 'proof');
}

// ------------------------------------------------------------------ done
function showDone(payout, jobId) {
  let stars = 0;
  const starsBox = h('div.stars', { style: { justifyContent: 'center', display: 'flex' } });
  const draw = () => mount(starsBox, [1, 2, 3, 4, 5].map((n) => h('button.star-btn', { class: n <= stars ? 'on' : '', onclick: () => { stars = n; draw(); } }, icon('star'))));
  draw();
  const panel = h('div.panel', {},
    h('div.done-hero', {}, h('div.small.muted', {}, 'Lavoro completato'), h('div.amt.num', {}, `+${eur(payout)}`), h('div.small.muted', {}, 'Prova verificata · pagamento rilasciato dall\'escrow (stub)')),
    h('div.sep'),
    h('h3.center', {}, 'Quanto erano chiare le istruzioni?'),
    h('div.xs.faint.center', {}, 'Valutazione a due vie: aiuta a filtrare clienti con richieste confuse.'),
    starsBox,
    h('button.btn.primary.lg.block', {
      style: { marginTop: '14px' },
      onclick: async () => {
        if (stars) { try { await wapi(`/partner/v1/jobs/${jobId}/rate-buyer`, { method: 'POST', body: { stars } }); } catch { /* */ } }
        closeOverlay();
      },
    }, 'Continua'));
  openOverlay(h('div.w-overlay', {}, panel), 'done');
}

// ------------------------------------------------------------------ profile
let geoWatch = null;
function showProfile() {
  const w = me.worker;
  const r = me.reliability;
  const T = r.thresholds;
  const meter = (val, warnAt, badAt) => h('div.meter', { class: val < badAt ? 'red' : val < warnAt ? 'warn' : '' }, h('i', { style: { width: `${Math.round(val * 100)}%` } }));
  const ratingFrac = r.rating.raw_avg != null ? (r.rating.raw_avg - 1) / 4 : 1;
  const panel = h('div.panel', {},
    h('div.row.between', {}, h('button.w-iconbtn', { onclick: closeOverlay, style: { boxShadow: 'none', background: 'var(--bg-2)' } }, icon('back')), h('b', {}, 'Profilo'), h('span', { style: { width: '46px' } })),
    h('div.row', { style: { margin: '16px 0' } },
      avatar(w.display_name, w.avatar_color, 'lg' + (w.kind === 'business' ? ' sq' : '')),
      h('div.grow', {},
        h('h2', {}, w.display_name),
        h('div.small.muted', {}, [w.kind === 'business' ? `${w.legal_name ?? ''} · ${w.vat_id ?? ''}` : 'Persona', w.zone, VEHICLE_IT[w.vehicle]].filter(Boolean).join(' · ')),
        h('div.row', { style: { marginTop: '6px', gap: '6px' } },
          w.verified ? h('span.badge.green', {}, icon('shield'), 'Verificato') : h('span.badge.blue', {}, 'In verifica'),
          h('span', { class: `badge ${r.tier === 'good' ? 'green' : r.tier === 'warning' ? 'warn' : 'red'}` }, `Affidabilità: ${tierLabel(r.tier)}`)))),
    h('div.grid2', {},
      h('div.stat', {}, h('b.num', {}, eur(w.earnings_cents)), h('span', {}, 'Guadagni totali')),
      h('div.stat', {}, h('b.num', {}, w.jobs_completed), h('span', {}, 'Lavori completati'))),
    h('h3', { style: { margin: '20px 0 10px' } }, 'Disponibilità e tariffa'),
    h('div.small.muted', {}, availabilityText(w.availability)),
    h('div.small.muted', { style: { marginTop: '4px' } }, `Tariffa minima: ${eur(w.min_hourly_cents)}/h · ${w.kind === 'business' ? `squadra di ${w.capacity}` : 'singolo'}${w.insured ? ' · RC assicurata' : ''}`),
    h('div.chips', { style: { marginTop: '8px' } }, w.skills.map((code) => h('span.badge', {}, cfg.services.find((x) => x.code === code)?.name_it ?? code))),
    h('h3', { style: { margin: '20px 0 10px' } }, 'Affidabilità'),
    r.reasons.length ? h('div.w-banner', { class: r.tier === 'suspended' ? 'red' : 'warn', style: { marginBottom: '10px' } }, icon('alert'), r.reasons.join(' · ')) : null,
    h('div.col', { style: { gap: '12px' } },
      h('div', {}, h('div.row.between.small', {}, h('span', {}, `Valutazione (ultimi ${r.rating.count} su max ${r.rating.window})`), h('b', {}, r.rating.raw_avg != null ? `★ ${r.rating.raw_avg.toFixed(2)}` : 'Nuovo')), meter(ratingFrac, (T.warn_rating - 1) / 4, (T.suspend_rating - 1) / 4)),
      h('div', {}, h('div.row.between.small', {}, h('span', {}, 'Completamento dei lavori accettati'), h('b', {}, pct(r.completion))), meter(r.completion, T.warn_completion, T.suspend_completion)),
      h('div', {}, h('div.row.between.small', {}, h('span', {}, 'Accettazione offerte'), h('b', {}, pct(r.acceptance))), meter(r.acceptance, 0, 0)),
      h('div.row.between.small', {}, h('span', {}, 'Cancellazioni dopo accettazione'), h('b', {}, pct(r.cancel_rate))),
      h('div.row.between.small', {}, h('span', {}, 'Mancate presenze'), h('b', {}, `${r.no_shows} / ${T.suspend_no_shows}`))),
    h('details', { style: { marginTop: '12px' } },
      h('summary.small', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Come funziona (modello Uber)'),
      h('ul.small.muted', { style: { paddingLeft: '18px' } },
        h('li', {}, `La valutazione è la media degli ultimi ${r.rating.window} lavori valutati; i profili nuovi partono da una media prudente.`),
        h('li', {}, 'Le valutazioni per problemi non tuoi (istruzioni poco chiare, luogo chiuso) non contano.'),
        h('li', {}, `Sotto ★${T.warn_rating} o ${T.warn_completion * 100}% di completamento: avviso, meno offerte, niente lavori oltre €${T.high_value_cents / 100}.`),
        h('li', {}, `Sotto ★${T.suspend_rating}, ${T.suspend_completion * 100}% di completamento o ${T.suspend_no_shows} mancate presenze: sospensione con revisione Ops.`),
        h('li', {}, 'Rifiutare un\'offerta pesa poco: conta portare a termine ciò che accetti.'))),
    h('h3', { style: { margin: '20px 0 8px' } }, 'Ultime recensioni'),
    me.reviews.length ? h('div.list', {}, me.reviews.map((rv) => h('div.item', {},
      h('b', {}, `★ ${rv.stars}`),
      h('div.grow.small', {}, rv.tags.join(', ') || '—', rv.comment ? h('div.muted', {}, `"${rv.comment}"`) : null, rv.excluded ? h('div.xs.faint', {}, 'Esclusa dalla media (non dipendeva da te)') : null)))) : h('div.small.muted', {}, 'Nessuna recensione su Aronica ancora.'),
    h('h3', { style: { margin: '20px 0 8px' } }, 'Storico'),
    me.history.length ? h('div.list', {}, me.history.map((j) => h('div.item', {},
      h('div.grow', {}, h('div.small', {}, j.title), h('div.xs.faint', {}, `${dayhhmm(j.completed_at)} · ${j.status}${j.contract ? ` · ${j.contract}` : ''}`)),
      h('b.num', { style: { color: j.pay_cents ? 'var(--accent)' : 'var(--fg-3)' } }, j.pay_cents ? `+${eur(j.pay_cents)}` : '—')))) : h('div.small.muted', {}, 'Nessun lavoro ancora.'),
    demo ? null : h('h3', { style: { margin: '20px 0 8px' } }, 'Posizione'),
    demo ? null : h('label.row.small', {},
      h('input', {
        type: 'checkbox', checked: !!w.real_gps,
        onchange: (e) => toggleRealGps(e.target.checked),
      }), 'Usa il GPS reale di questo dispositivo (altrimenti posizione simulata per la demo)'),
    h('div.sep'),
    h('button.btn.block', { onclick: () => { closeOverlay(); logout(); } }, 'Esci'));
  openOverlay(h('div.w-overlay.full', {}, panel), 'profile');
}

const DOW = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
function availabilityText(av = {}) {
  const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => av[d]?.length);
  if (!days.length) return 'Nessuna disponibilità impostata';
  const r = av[days[0]].map(([a, b]) => `${hh(a)}–${hh(b)}`).join(', ');
  return `${days.map((d) => DOW[d]).join(' ')} · ${r}`;
}

function toggleRealGps(on) {
  if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  if (!on) { wapi('/partner/v1/location', { method: 'POST', body: { real: false } }); return; }
  if (!navigator.geolocation) return toast('GPS non disponibile', true);
  geoWatch = navigator.geolocation.watchPosition(
    (p) => wapi('/partner/v1/location', { method: 'POST', body: { lat: p.coords.latitude, lng: p.coords.longitude } }).catch(() => {}),
    () => toast('Permesso GPS negato', true),
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

