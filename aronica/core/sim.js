// Demo simulator (clearly labelled wherever it shows up):
//  1. Movement: partners en route glide toward the job at vehicle speed ×
//     sim_speedup, unless their app is streaming real GPS.
//  2. Seed personas (workers.simulated = 1) whose app is not open answer offers
//     by their historical acceptance rate, leave in time for their slot,
//     check in, and deliver proof (placeholder photos flagged `simulated`).
// Real signed-up partners are never simulated.
import { get, all, update, getSetting, setSetting } from './db.js';
import { emit, workerHasLiveApp } from './events.js';
import { VEHICLES, haversineKm, etaMinutes } from './geo.js';
import { metrics } from './reliability.js';
import { respondOffer, startJob, arriveJob, submitProof } from './dispatch.js';
import { getService } from './services.js';
import { clock } from './util.js';

// Stateless (serverless-safe): every decision is derived from the record's id,
// so any instance running the tick reaches the same decision at the same time.
function unit(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}
const between = (seedStr, a, b) => a + unit(seedStr) * (b - a);

export async function simEnabled() {
  return await getSetting('simulate_workers', true);
}

export async function moveWorkers() {
  const now = clock.now();
  const last = await getSetting('sim_last_move', now);
  const dtMs = Math.max(0, Math.min(10_000, now - last));
  await setSetting('sim_last_move', now);
  if (!dtMs) return;
  const speedup = await getSetting('sim_speedup', 30);
  const rows = await all("SELECT a.worker_id, j.id AS job_id, j.lat, j.lng, j.proof_req FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.status = 'en_route'");
  for (const r of rows) {
    const w = await get('SELECT * FROM workers WHERE id = ?', r.worker_id);
    if (!w || w.real_gps) continue;
    const target = { lat: r.lat, lng: r.lng };
    const remaining = haversineKm(w, target);
    const stepKm = ((VEHICLES[w.vehicle]?.speed ?? 12) / 1.3) * (dtMs / 3600000) * speedup;
    let lat = target.lat + 0.0002;
    let lng = target.lng + 0.0002;
    if (remaining > stepKm && remaining > 0.02) {
      const f = stepKm / remaining;
      lat = w.lat + (target.lat - w.lat) * f;
      lng = w.lng + (target.lng - w.lng) * f;
    }
    await update('workers', w.id, { lat, lng });
    const left = haversineKm({ lat, lng }, target);
    await emit('worker.location', {
      job_id: r.job_id, worker_id: w.id,
      data: { lat, lng, remaining_m: Math.round(left * 1000), eta_min: Math.max(0, Math.round(((left * 1.3) / (VEHICLES[w.vehicle]?.speed ?? 12)) * 60)), simulated: true, within_geofence: left * 1000 <= r.proof_req.gps_radius_m },
    });
  }
}

async function botControls(workerId) {
  const w = await get('SELECT simulated FROM workers WHERE id = ?', workerId);
  return w?.simulated && !await workerHasLiveApp(workerId);
}

function placeholderPhoto(job, n, total) {
  const s = getService(job.service);
  const ts = new Date(clock.now()).toISOString().replace('T', ' ').slice(0, 16);
  const hue = (n * 67) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
<rect width="640" height="480" fill="hsl(${hue},18%,22%)"/>
<rect x="40" y="60" width="560" height="300" rx="10" fill="hsl(${hue},18%,30%)" stroke="#fff3" stroke-dasharray="8 8"/>
<text x="320" y="190" fill="#fff" font-family="sans-serif" font-size="28" text-anchor="middle" font-weight="700">FOTO SIMULATA · DEMO</text>
<text x="320" y="230" fill="#fffc" font-family="sans-serif" font-size="18" text-anchor="middle">${s.name_it} · ${n}/${total}</text>
<text x="320" y="262" fill="#fff9" font-family="sans-serif" font-size="15" text-anchor="middle">Nessuna foto reale: partner simulato dal demo</text>
<text x="40" y="420" fill="#fffb" font-family="monospace" font-size="15">${ts} UTC</text>
<text x="40" y="445" fill="#fffb" font-family="monospace" font-size="15">GPS ${job.lat.toFixed(5)}, ${job.lng.toFixed(5)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function botAnswers(job) {
  const out = {};
  for (const item of job.proof_req.checklist ?? []) {
    if (item.type === 'yes_no') out[item.id] = item.id === 'damages' ? 'no' : 'yes';
    else if (item.type === 'number') out[item.id] = item.id === 'spesa_eur' ? Math.min(job.params?.spesa_max_eur ?? 50, Math.round((job.params?.spesa_max_eur ?? 50) * 0.8)) : 3;
    else out[item.id] = 'Risposta simulata dal demo (partner non reale).';
  }
  return out;
}

export async function runBots() {
  if (!await simEnabled()) return;
  const now = clock.now();
  for (const o of await all("SELECT * FROM offers WHERE status = 'pending'")) {
    if (!await botControls(o.worker_id)) continue;
    const at = o.created_at + between(`${o.id}:t`, 2500, 7000);
    if (now >= at && now < o.expires_at) {
      const w = await get('SELECT * FROM workers WHERE id = ?', o.worker_id);
      const accept = unit(`${o.id}:a`) < (await metrics(w)).acceptance;
      try { await respondOffer(o.worker_id, o.id, accept, { via: 'sim' }); } catch { /* raced */ }
    }
  }
  const rows = await all("SELECT a.*, j.slot_start, j.duration_min, j.lat, j.lng, j.proof_req, j.service, j.params FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.assigned_via = 'sim' AND a.status IN ('assigned','en_route','on_site')");
  for (const a of rows) {
    if (!await botControls(a.worker_id)) continue;
    const since = { assigned: a.assigned_at, en_route: a.started_at, on_site: a.arrived_at }[a.status] ?? a.assigned_at;
    if (now < since + between(`${a.id}:${a.status}`, 2000, 4000)) continue;
    try {
      if (a.status === 'assigned') {
        const w = await get('SELECT * FROM workers WHERE id = ?', a.worker_id);
        const eta = etaMinutes(w, a, w.vehicle);
        // Leave in time for the slot (with 15 min of margin), not earlier.
        if (now >= a.slot_start - (eta + 15) * 60000) await startJob(a.worker_id, a.job_id);
      } else if (a.status === 'en_route') {
        const w = await get('SELECT * FROM workers WHERE id = ?', a.worker_id);
        if (haversineKm(w, a) * 1000 <= 40) await arriveJob(a.worker_id, a.job_id);
      } else if (a.status === 'on_site' && a.proof_req.kind === 'photos') {
        const n = a.proof_req.photos_min;
        await submitProof(a.worker_id, a.job_id, { photos: Array.from({ length: n }, (_, i) => placeholderPhoto(a, i + 1, n)), answers: await botAnswers(a), simulated: true });
      }
      // timesheet: checked out at the end of the shift by the dispatch loop
    } catch { /* state moved on */ }
  }
}
