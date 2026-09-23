// Ops: live platform view — supply map, reliability tiers, verification queue,
// dispatch cascade, event log, demo settings, API keys.
import { h, mount, api, sse, eur, pct, hhmm, toast, avatar, createMap, taskPin, workerPin, VEHICLE_IT } from './common.js';

let main;
let log;
let settingsEl;
let map;
let state;
let newKey = null;

async function load() {
  state = await api('/api/ops/state');
  render();
}

let t = null;
const reload = () => { clearTimeout(t); t = setTimeout(load, 300); };

const tierBadge = (w) => w.status === 'pending_verification' ? h('span.badge.blue', {}, 'In verifica')
  : w.status === 'suspended' ? h('span.badge.red', {}, 'Sospeso')
  : w.tier === 'warning' ? h('span.badge.warn', {}, 'Avviso') : h('span.badge.green', {}, 'Buono');

async function act(path, body) {
  try { await api(path, { method: 'POST', body: body ?? {} }); reload(); } catch (e) { toast(e.message, true); }
}

function render() {
  const s = state.settings;
  mount(settingsEl,
    h('label.row', {}, 'TTL offerta', h('input.input', { type: 'number', min: 5, max: 120, value: s.offer_ttl_s, style: { width: '72px', padding: '6px 8px' }, onchange: (e) => act('/api/ops/settings', { offer_ttl_s: Number(e.target.value) }) }), 's'),
    h('label.row', {}, 'Velocità sim.', h('input.input', { type: 'number', min: 1, max: 120, value: s.sim_speedup, style: { width: '72px', padding: '6px 8px' }, onchange: (e) => act('/api/ops/settings', { sim_speedup: Number(e.target.value) }) }), '×'),
    h('label.row', {}, h('input', { type: 'checkbox', checked: s.simulate_workers, onchange: (e) => act('/api/ops/settings', { simulate_workers: e.target.checked }) }), 'Simula profili demo'));

  const W = state.workers;
  const online = W.filter((w) => w.online && w.status === 'active');
  const live = state.jobs.filter((j) => ['dispatching', 'assigned', 'en_route', 'on_site'].includes(j.status));
  const done = state.jobs.filter((j) => j.status === 'done');
  const pending = W.filter((w) => w.status === 'pending_verification');

  const workerRow = (w) => h('tr', {},
    h('td', {}, h('div.row', {}, avatar(w.display_name, w.avatar_color, w.kind === 'business' ? 'sq' : ''), h('div', {}, h('b', {}, w.display_name), h('div.xs.faint', {}, `${w.kind === 'business' ? 'Business · cap. ' + w.capacity : 'Persona'} · ${w.zone} · ${VEHICLE_IT[w.vehicle]}`)))),
    h('td', {}, tierBadge(w), w.reasons.length ? h('div.xs.faint', { style: { maxWidth: '240px', marginTop: '4px' } }, w.reasons.join(' · ')) : null),
    h('td.num', {}, w.rating != null ? `★ ${w.rating.toFixed(2)}` : '—', h('div.xs.faint', {}, `${w.ratings} val. · bayes ${w.rating_bayes.toFixed(2)}`)),
    h('td.num', {}, pct(w.completion)),
    h('td.num', {}, pct(w.acceptance)),
    h('td.num', {}, w.no_shows),
    h('td', {}, w.online ? h('span.badge.green', {}, w.active_jobs ? `Occupato ${w.active_jobs}/${w.capacity}` : 'Online') : h('span.badge', {}, 'Offline')),
    h('td.xs', {}, w.skills.join(', ')),
    h('td', {}, h('div.row', { style: { gap: '6px' } },
      w.status === 'pending_verification' ? h('button.btn.sm.primary', { onclick: () => act(`/api/ops/workers/${w.id}/verify`) }, 'Verifica') : null,
      w.status === 'suspended' ? h('button.btn.sm', { onclick: () => act(`/api/ops/workers/${w.id}/reinstate`) }, 'Riattiva') : null,
      w.status === 'active' ? h('button.btn.sm', { onclick: () => act(`/api/ops/workers/${w.id}/toggle-online`) }, w.online ? 'Metti offline' : 'Metti online') : null)));

  const jobRow = (j) => h('tr', {},
    h('td', {}, h('b', {}, j.title), h('div.xs.faint', {}, `${j.id} · ${j.skill} · ${j.agent_name}`)),
    h('td', {}, h('span.badge', { class: j.status === 'done' ? 'green' : ['no_match', 'expired', 'cancelled'].includes(j.status) ? 'red' : 'blue' }, j.status)),
    h('td.num', {}, j.deal?.price_cents ? eur(j.deal.price_cents) : '—'),
    h('td', {}, j.worker ? j.worker.alias : j.dispatch ? `offerte ${j.dispatch.tried}/${j.dispatch.pool_size}` : '—'),
    h('td.num', {}, hhmm(j.created_at)));

  const offerRow = (o) => h('tr', {},
    h('td.mono.xs', {}, o.job_id),
    h('td.num', {}, `#${o.rank}`),
    h('td', {}, o.display_name),
    h('td.num', {}, o.score),
    h('td', {}, h('span.badge', { class: o.status === 'accepted' ? 'green' : o.status === 'pending' ? 'blue' : '' }, o.status)),
    h('td.num', {}, hhmm(o.created_at)));

  mount(main,
    h('div.kpis', {},
      h('div.stat', {}, h('b', {}, online.length), h('span', {}, 'Partner online')),
      h('div.stat', {}, h('b', {}, live.length), h('span', {}, 'Lavori in corso')),
      h('div.stat', {}, h('b', {}, done.length), h('span', {}, 'Completati (recenti)')),
      h('div.stat', {}, h('b', {}, pending.length), h('span', {}, 'Da verificare')),
      h('div.stat', {}, h('b', {}, W.filter((w) => w.status === 'suspended').length), h('span', {}, 'Sospesi'))),
    h('section', {}, h('h3', { style: { marginBottom: '8px' } }, 'Partner (persone e attività)'),
      h('div.tablewrap', {}, h('table.table', {},
        h('thead', {}, h('tr', {}, ['Partner', 'Affidabilità', 'Valutazione', 'Complet.', 'Accett.', 'No-show', 'Stato', 'Competenze', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, W.map(workerRow))))),
    h('section', {}, h('h3', { style: { marginBottom: '8px' } }, 'Lavori'),
      h('div.tablewrap', {}, h('table.table', {},
        h('thead', {}, h('tr', {}, ['Lavoro', 'Stato', 'Prezzo', 'Partner / cascata', 'Creato'].map((x) => h('th', {}, x)))),
        h('tbody', {}, state.jobs.length ? state.jobs.map(jobRow) : h('tr', {}, h('td.muted', { colspan: 5 }, 'Nessun lavoro ancora. Crea una richiesta dal Buyer console o da un agente.')))))),
    h('section', {}, h('h3', { style: { marginBottom: '8px' } }, 'Offerte a tempo (cascata)'),
      h('div.tablewrap', {}, h('table.table', {},
        h('thead', {}, h('tr', {}, ['Job', 'Rank', 'Partner', 'Score', 'Esito', 'Inviata'].map((x) => h('th', {}, x)))),
        h('tbody', {}, state.offers.length ? state.offers.map(offerRow) : h('tr', {}, h('td.muted', { colspan: 6 }, '—')))))),
    h('section', {}, h('h3', { style: { marginBottom: '8px' } }, 'API key per agenti'),
      h('div.tablewrap', {}, h('table.table', {}, h('tbody', {}, state.accounts.map((a) => h('tr', {}, h('td', {}, a.name), h('td.mono', {}, a.api_key), h('td.xs.faint', {}, a.created_at)))))),
      newKey ? h('div.card.flat.small', { style: { marginTop: '8px' } }, 'Nuova chiave (mostrata una sola volta): ', h('b.mono', {}, newKey)) : null,
      h('div.row', { style: { marginTop: '8px' } },
        h('input.input', { id: 'keyname', placeholder: 'Nome agente (es. Grok Bot)', style: { maxWidth: '260px' } }),
        h('button.btn.sm.primary', {
          onclick: async () => {
            const r = await api('/api/ops/keys', { method: 'POST', body: { name: main.querySelector('#keyname').value || 'Agent' } });
            newKey = r.api_key; load();
          },
        }, 'Crea chiave'))));

  drawMap();
}

function drawMap() {
  const seen = new Set();
  for (const w of state.workers) {
    if (w.status === 'pending_verification') continue;
    seen.add(`w:${w.id}`);
    map.set(`w:${w.id}`, { lat: w.lat, lng: w.lng, html: workerPin(w.display_name, w.avatar_color, { off: !w.online || w.status !== 'active', busy: w.active_jobs > 0 }), animate: true });
  }
  for (const j of state.jobs.filter((x) => ['dispatching', 'assigned', 'en_route', 'on_site'].includes(x.status))) {
    seen.add(`j:${j.id}`);
    map.set(`j:${j.id}`, { lat: j.location.lat, lng: j.location.lng, html: taskPin(null, { pulse: j.status === 'dispatching' }), z: 400 });
  }
  map._seen?.forEach((id) => { if (!seen.has(id)) map.remove(id); });
  map._seen = seen;
}

function logLine(e) {
  const d = e.data ?? {};
  const txt = d.message ?? d.alias ?? d.reason ?? (d.rank ? `#${d.rank}` : '') ?? '';
  log.prepend(h('div', {}, h('span.t', {}, hhmm(e.at)), h('span.ty', {}, e.type), h('span.muted', {}, [e.job_id, e.worker_id, typeof txt === 'string' ? txt : ''].filter(Boolean).join(' · '))));
  while (log.childElementCount > 200) log.lastElementChild.remove();
}

export async function mountOps({ mainEl, logEl, settingsEl: setEl, mapEl }) {
  main = mainEl; log = logEl; settingsEl = setEl;
  map = createMap(mapEl, { zoom: 12 });
  await load();
  for (const e of [...state.events].reverse()) logLine(e);
  sse('/api/stream?ops=1', (e) => {
    if (e.type === 'worker.location') {
      const w = state.workers.find((x) => x.id === e.worker_id);
      if (w) { w.lat = e.data.lat; w.lng = e.data.lng; drawMap(); }
      return;
    }
    logLine(e);
    reload();
  });
}
