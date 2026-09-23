// Shared front-end toolkit: DOM builder, API client, SSE, formatting, icons, map.
export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // only used with trusted, static strings
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function mount(root, ...kids) {
  root.replaceChildren(...kids.flat().filter(Boolean));
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    Object.assign(err, { status: res.status, data });
    throw err;
  }
  return data;
}

// Named SSE events don't hit onmessage and dispatchEvent patching isn't used by
// browsers, so listen for every type we emit.
export const EVENT_TYPES = [
  'job.created', 'job.unsupported', 'job.no_match', 'job.confirmed', 'job.assigned', 'job.en_route', 'job.on_site',
  'job.proof_submitted', 'job.proof_rejected', 'job.done', 'job.cancelled', 'job.expired', 'job.worker_cancelled',
  'negotiation.started', 'negotiation.buyer_offer', 'negotiation.supplier_response', 'negotiation.deal', 'negotiation.failed',
  'dispatch.offer_sent', 'dispatch.offer_expired', 'dispatch.offer_declined', 'dispatch.offer_accepted', 'dispatch.skipped', 'dispatch.pool_extended',
  'escrow.held', 'escrow.released', 'escrow.refunded', 'worker.location', 'worker.online', 'worker.offline', 'worker.tier_changed',
  'worker.no_show', 'worker.verified', 'worker.reinstated', 'worker.signed_up', 'rating.created', 'rating.buyer_rated',
];
export function sse(url, onEvent) {
  const es = new EventSource(url);
  const handler = (m) => { try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
  for (const t of EVENT_TYPES) es.addEventListener(t, handler);
  es.onmessage = handler;
  return es;
}

// ---- formatting
export const eur = (c) => (c == null ? '—' : `€${(c / 100).toFixed(2).replace('.', ',')}`);
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—');
export const dayhhmm = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}
export function minsUntil(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}
export function deadlineText(iso) {
  const m = minsUntil(iso);
  if (m < 0) return 'Scaduto';
  if (m < 90) return `Entro ${m} min · ${hhmm(iso)}`;
  return `Entro ${dayhhmm(iso)}`;
}

let toastTimer;
export function toast(msg, err = false) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---- icons (inline SVG, stroke-based)
const P = {
  pin: '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z" fill="currentColor"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h5l3 8M10 8l2 8"/>',
  scooter: '<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17H15l1-6h3M16 11l-1-5h-2"/>',
  car: '<path d="M4 16v-4l2-5h12l2 5v4z"/><circle cx="8" cy="16.5" r="1.5"/><circle cx="16" cy="16.5" r="1.5"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M11 21l2-6 3 3v3M13 15l-1-6-3 3H7M12 9l4 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 13h18"/>',
  euro: '<path d="M17 6.5A6.5 6.5 0 1 0 17 17.5M4 10.5h9M4 13.5h9"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/>',
  agent: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 13h.01M15 13h.01M9 16h6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  power: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/>',
};
export function icon(name, cls = 'ico-svg') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ''}</svg>`;
  return span.firstChild;
}
export const vehicleIcon = (v) => icon({ bike: 'bike', scooter: 'scooter', car: 'car', walk: 'walk' }[v] ?? 'bike');
export const VEHICLE_IT = { bike: 'Bici', scooter: 'Scooter', car: 'Auto', walk: 'A piedi' };

export function avatar(name, color, cls = '') {
  return h(`div.avatar${cls ? '.' + cls : ''}`, { style: { background: color || '#333' } }, initials(name));
}

export function starsView(n) {
  return h('span.row', { style: { gap: '4px' } }, icon('star', 'ico-svg'), h('b.num', {}, n == null ? 'Nuovo' : Number(n).toFixed(2)));
}

export function ring(secondsLeft, total, size = 64) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, secondsLeft / total));
  const wrap = h('div.ring', { style: { width: `${size}px`, height: `${size}px` } });
  wrap.innerHTML = `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--bg-3)" stroke-width="5" fill="none"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${frac < 0.3 ? 'var(--danger)' : 'var(--fg)'}" stroke-width="5" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - frac)}"/></svg>`;
  wrap.append(h('div.t.num', {}, Math.max(0, Math.ceil(secondsLeft))));
  return wrap;
}

export function lightbox(src) {
  const lb = h('div.lightbox', { onclick: () => lb.remove() }, h('img', { src, alt: 'Prova' }));
  document.body.append(lb);
}

// ---------------------------------------------------------------------- map
// Leaflet + CARTO basemap when available; stylised offline SVG Milano otherwise.
const MILANO = { lat: 45.4642, lng: 9.19 };

export function createMap(el, { dark = false, zoom = 13, center = MILANO, onClick } = {}) {
  if (window.L) return leafletMap(el, { dark, zoom, center, onClick });
  return svgMap(el, { dark, center, onClick });
}

function lerpMarker(marker, to, ms = 1800) {
  const from = marker.getLatLng();
  const t0 = performance.now();
  cancelAnimationFrame(marker._anim);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    marker.setLatLng([from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k]);
    if (k < 1) marker._anim = requestAnimationFrame(step);
  };
  marker._anim = requestAnimationFrame(step);
}

function leafletMap(el, { dark, zoom, center, onClick }) {
  const L = window.L;
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], zoom);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 19, subdomains: 'abcd', attribution: '© OpenStreetMap © CARTO',
  }).addTo(map);
  if (onClick) map.on('click', (e) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }));
  const markers = new Map();
  const lines = new Map();
  return {
    kind: 'leaflet',
    set(id, { lat, lng, html, z = 0, animate = false }) {
      let m = markers.get(id);
      const icon = L.divIcon({ className: '', html, iconSize: [0, 0] });
      if (!m) {
        m = L.marker([lat, lng], { icon, zIndexOffset: z, keyboard: false }).addTo(map);
        m._html = html;
        markers.set(id, m);
      } else {
        if (m._html !== html) { m.setIcon(icon); m._html = html; }
        if (animate) lerpMarker(m, { lat, lng }); else m.setLatLng([lat, lng]);
      }
    },
    remove(id) { const m = markers.get(id); if (m) { m.remove(); markers.delete(id); } },
    clear() { for (const id of [...markers.keys()]) this.remove(id); for (const id of [...lines.keys()]) this.line(id, null); },
    has: (id) => markers.has(id),
    line(id, pts, { color = dark ? '#fff' : '#000', dash = null, weight = 4 } = {}) {
      const l = lines.get(id);
      if (!pts) { if (l) { l.remove(); lines.delete(id); } return; }
      if (l) l.setLatLngs(pts.map((p) => [p.lat, p.lng]));
      else lines.set(id, L.polyline(pts.map((p) => [p.lat, p.lng]), { color, weight, dashArray: dash, opacity: 0.9 }).addTo(map));
    },
    fit(points, pad = 60) {
      const pts = points.filter(Boolean);
      if (!pts.length) return;
      if (pts.length === 1) return map.setView([pts[0].lat, pts[0].lng], 15, { animate: true });
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [pad, pad], maxZoom: 16, animate: true });
    },
    padBottom(px) { el.style.bottom = '0'; this._padBottom = px; },
    view(p, z) { map.setView([p.lat, p.lng], z ?? map.getZoom(), { animate: true }); },
    invalidate() { map.invalidateSize(); },
  };
}

// Offline fallback: a stylised Milano (Cerchia dei Navigli, Bastioni, Circonvallazione,
// Navigli canals, Parco Sempione) with HTML markers positioned by projection.
function svgMap(el, { dark, center, onClick }) {
  el.classList.add('svgmap');
  let view = { lat: center.lat, lng: center.lng, span: 0.09 }; // degrees of longitude across
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'svgmap-layer');
  svg.setAttribute('preserveAspectRatio', 'none');
  const layer = document.createElement('div');
  layer.className = 'svgmap-layer';
  el.append(svg, layer);
  const markers = new Map();
  const lines = new Map();
  const col = dark
    ? { bg: '#1b1b1b', road: '#2f2f2f', ring: '#3a3a3a', water: '#16324a', park: '#1f2f22', text: '#666' }
    : { bg: '#ececec', road: '#ffffff', ring: '#ffffff', water: '#b9d3ea', park: '#d4e7cf', text: '#999' };
  const kmLat = 111.2;
  const kmLng = 78.0;
  const proj = (p) => {
    const w = el.clientWidth || 1;
    const hgt = el.clientHeight || 1;
    const spanLng = view.span;
    const spanLat = spanLng * (hgt / w) * (kmLng / kmLat);
    return { x: ((p.lng - view.lng) / spanLng + 0.5) * w, y: (0.5 - (p.lat - view.lat) / spanLat) * hgt };
  };
  const unproj = (x, y) => {
    const w = el.clientWidth || 1;
    const hgt = el.clientHeight || 1;
    const spanLat = view.span * (hgt / w) * (kmLng / kmLat);
    return { lng: view.lng + (x / w - 0.5) * view.span, lat: view.lat - (y / hgt - 0.5) * spanLat };
  };
  const ringPath = (rKm) => {
    const pts = [];
    for (let a = 0; a <= 360; a += 10) {
      const t = (a * Math.PI) / 180;
      const p = proj({ lat: MILANO.lat + (rKm * Math.sin(t) * 0.92) / kmLat, lng: MILANO.lng + (rKm * Math.cos(t)) / kmLng });
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    return `M${pts.join('L')}Z`;
  };
  const poly = (coords) => coords.map((c, i) => { const p = proj({ lat: c[0], lng: c[1] }); return `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join('');
  function draw() {
    const w = el.clientWidth;
    const hgt = el.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    const radials = [];
    for (let a = 0; a < 360; a += 30) {
      const t = (a * Math.PI) / 180;
      radials.push(poly([[MILANO.lat, MILANO.lng], [MILANO.lat + (9 * Math.sin(t)) / kmLat, MILANO.lng + (9 * Math.cos(t)) / kmLng]]));
    }
    svg.innerHTML = `
      <rect width="${w}" height="${hgt}" fill="${col.bg}"/>
      <path d="${poly([[45.4755, 9.167], [45.4755, 9.1785], [45.468, 9.1785], [45.468, 9.1705]])}" fill="${col.park}"/>
      <path d="${poly([[45.452, 9.175], [45.445, 9.155], [45.438, 9.13]])}" stroke="${col.water}" stroke-width="6" fill="none"/>
      <path d="${poly([[45.452, 9.18], [45.44, 9.182], [45.42, 9.186]])}" stroke="${col.water}" stroke-width="5" fill="none"/>
      <path d="${poly([[45.487, 9.23], [45.5, 9.245], [45.51, 9.26]])}" stroke="${col.water}" stroke-width="4" fill="none"/>
      ${radials.map((d) => `<path d="${d}" stroke="${col.road}" stroke-width="3" fill="none"/>`).join('')}
      <path d="${ringPath(0.85)}" stroke="${col.ring}" stroke-width="5" fill="none"/>
      <path d="${ringPath(1.9)}" stroke="${col.ring}" stroke-width="7" fill="none"/>
      <path d="${ringPath(3.6)}" stroke="${col.ring}" stroke-width="8" fill="none"/>
      <path d="${ringPath(6.5)}" stroke="${col.road}" stroke-width="4" fill="none"/>
      <text x="${proj(MILANO).x + 8}" y="${proj(MILANO).y - 8}" fill="${col.text}" font-size="11" font-family="sans-serif">Duomo</text>
      <text x="8" y="${hgt - 8}" fill="${col.text}" font-size="10" font-family="sans-serif">Mappa stilizzata offline</text>`;
    for (const [id, l] of lines) drawLine(id, l);
    for (const m of markers.values()) place(m, false);
  }
  function place(m, animate) {
    const p = proj(m);
    m.el.style.transition = animate ? '' : 'none';
    m.el.style.left = `${p.x}px`;
    m.el.style.top = `${p.y}px`;
  }
  function drawLine(id, l) {
    let path = svg.querySelector(`[data-line="${id}"]`);
    if (!path) { path = document.createElementNS(svgNS, 'path'); path.setAttribute('data-line', id); svg.append(path); }
    path.setAttribute('d', poly(l.pts.map((p) => [p.lat, p.lng])));
    path.setAttribute('stroke', l.color);
    path.setAttribute('stroke-width', l.weight);
    path.setAttribute('fill', 'none');
    if (l.dash) path.setAttribute('stroke-dasharray', l.dash);
  }
  new ResizeObserver(draw).observe(el);
  if (onClick) el.addEventListener('click', (e) => { if (e.target.closest('.svgmap-pin')) return; const r = el.getBoundingClientRect(); onClick(unproj(e.clientX - r.left, e.clientY - r.top)); });
  draw();
  return {
    kind: 'svg',
    set(id, { lat, lng, html, z = 0, animate = false }) {
      let m = markers.get(id);
      if (!m) {
        m = { el: document.createElement('div'), lat, lng, html: null };
        m.el.className = 'svgmap-pin';
        layer.append(m.el);
        markers.set(id, m);
      }
      if (m.html !== html) { m.el.innerHTML = html; m.html = html; }
      m.el.style.zIndex = String(100 + z);
      m.lat = lat; m.lng = lng;
      place(m, animate);
    },
    remove(id) { const m = markers.get(id); if (m) { m.el.remove(); markers.delete(id); } },
    clear() { for (const id of [...markers.keys()]) this.remove(id); for (const id of [...lines.keys()]) this.line(id, null); },
    has: (id) => markers.has(id),
    line(id, pts, { color = dark ? '#fff' : '#000', dash = null, weight = 4 } = {}) {
      if (!pts) { lines.delete(id); svg.querySelector(`[data-line="${id}"]`)?.remove(); return; }
      const l = { pts, color, dash, weight };
      lines.set(id, l);
      drawLine(id, l);
    },
    fit(points) {
      const pts = points.filter(Boolean);
      if (!pts.length) return;
      const lats = pts.map((p) => p.lat); const lngs = pts.map((p) => p.lng);
      view = {
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
        span: Math.max(0.012, (Math.max(...lngs) - Math.min(...lngs)) * 1.8, (Math.max(...lats) - Math.min(...lats)) * 1.8 * 1.4),
      };
      draw();
    },
    view(p) { view = { ...view, lat: p.lat, lng: p.lng }; draw(); },
    invalidate: draw,
  };
}

// Marker HTML helpers (strings; all dynamic text is escaped).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const taskPin = (label, { done = false, pulse = false } = {}) =>
  `<div class="mk">${pulse ? '<div class="pulse-ring"></div><div class="pulse-ring r2"></div><div class="pulse-ring r3"></div>' : ''}<div class="mk-task${done ? ' done' : ''}"></div>${label ? `<div class="mk-label">${esc(label)}</div>` : ''}</div>`;
export const workerPin = (name, color, { off = false, busy = false, label = null } = {}) =>
  `<div class="mk"><div class="mk-worker${off ? ' off' : ''}${busy ? ' busy' : ''}" style="background:${esc(color || '#333')}">${esc(initials(name))}</div>${label ? `<div class="mk-label">${esc(label)}</div>` : ''}</div>`;
export const mePin = () => '<div class="mk"><div class="mk-me"></div></div>';
