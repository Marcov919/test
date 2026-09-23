// Demo simulator (clearly labelled everywhere it shows up):
//  1. Movement: workers en route glide toward the task at their vehicle speed ×
//     sim_speedup, unless their app is streaming real GPS.
//  2. Seed personas (workers.simulated = 1) with no human holding their app
//     open answer offers according to their historical acceptance rate and
//     complete jobs with placeholder photos flagged `simulated: true`.
// Real signed-up workers are never simulated.
import { get, all, update, getSetting } from './db.js';
import { emit, workerHasLiveApp, realGps } from './events.js';
import { VEHICLES, haversineKm } from './geo.js';
import { metrics } from './reliability.js';
import { respondOffer, startJob, arriveJob, submitProof } from './dispatch.js';
import { getSkill } from './skills.js';
import { clock } from './util.js';

const plans = new Map(); // offerId -> { at, accept }
const jobPlans = new Map(); // jobId -> next action time

const rand = (a, b) => a + Math.random() * (b - a);

export function simEnabled() {
  return getSetting('simulate_workers', true);
}

export function moveWorkers(dtMs) {
  const speedup = getSetting('sim_speedup', 30);
  for (const j of all("SELECT * FROM jobs WHERE status = 'en_route'")) {
    const w = get('SELECT * FROM workers WHERE id = ?', j.assigned_worker_id);
    if (!w || realGps.has(w.id)) continue;
    const remainingKm = haversineKm(w, j);
    const stepKm = ((VEHICLES[w.vehicle]?.speed ?? 12) / 1.3) * (dtMs / 3600000) * speedup;
    let lat = j.lat;
    let lng = j.lng;
    if (remainingKm > stepKm && remainingKm > 0.02) {
      const f = stepKm / remainingKm;
      lat = w.lat + (j.lat - w.lat) * f;
      lng = w.lng + (j.lng - w.lng) * f;
    } else {
      // Park just inside the geofence rather than exactly on the pin.
      lat = j.lat + 0.0002;
      lng = j.lng + 0.0002;
    }
    update('workers', w.id, { lat, lng });
    const left = haversineKm({ lat, lng }, j);
    const etaMin = Math.max(0, Math.round(((left * 1.3) / (VEHICLES[w.vehicle]?.speed ?? 12)) * 60));
    emit('worker.location', {
      job_id: j.id, worker_id: w.id,
      data: { lat, lng, remaining_m: Math.round(left * 1000), eta_min: etaMin, simulated: true, within_geofence: left * 1000 <= j.proof_req.gps_radius_m },
    });
  }
}

function botControls(workerId) {
  const w = get('SELECT simulated FROM workers WHERE id = ?', workerId);
  return w?.simulated && !workerHasLiveApp(workerId);
}

function placeholderPhoto(job, n) {
  const skill = getSkill(job.skill);
  const ts = new Date(clock.now()).toISOString().replace('T', ' ').slice(0, 16);
  const hue = (n * 67) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
<rect width="640" height="480" fill="hsl(${hue},18%,22%)"/>
<rect x="40" y="60" width="560" height="300" rx="10" fill="hsl(${hue},18%,30%)" stroke="#fff3" stroke-dasharray="8 8"/>
<text x="320" y="190" fill="#fff" font-family="sans-serif" font-size="28" text-anchor="middle" font-weight="700">FOTO SIMULATA · DEMO</text>
<text x="320" y="230" fill="#fffc" font-family="sans-serif" font-size="18" text-anchor="middle">${skill.name_it} · ${n}/${job.proof_req.photos_min}</text>
<text x="320" y="262" fill="#fff9" font-family="sans-serif" font-size="15" text-anchor="middle">Nessuna foto reale: persona simulata dal demo</text>
<text x="40" y="420" fill="#fffb" font-family="monospace" font-size="15">${ts} UTC</text>
<text x="40" y="445" fill="#fffb" font-family="monospace" font-size="15">GPS ${job.lat.toFixed(5)}, ${job.lng.toFixed(5)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function botAnswers(job) {
  const out = {};
  for (const item of job.proof_req.checklist) {
    if (item.type === 'yes_no') out[item.id] = 'yes';
    else if (item.type === 'number') out[item.id] = item.id === 'service_score' ? 4 : 3;
    else out[item.id] = 'Risposta simulata dal demo (persona non reale).';
  }
  return out;
}

export function runBots() {
  if (!simEnabled()) return;
  const now = clock.now();
  // Offers
  for (const o of all("SELECT * FROM offers WHERE status = 'pending'")) {
    if (!botControls(o.worker_id)) { plans.delete(o.id); continue; }
    let p = plans.get(o.id);
    if (!p) {
      const w = get('SELECT * FROM workers WHERE id = ?', o.worker_id);
      const acc = metrics(w).acceptance;
      p = { at: now + rand(2500, 6500), accept: Math.random() < acc };
      plans.set(o.id, p);
    }
    if (now >= p.at && now < o.expires_at) {
      plans.delete(o.id);
      try { respondOffer(o.worker_id, o.id, p.accept, { via: 'sim' }); } catch { /* raced */ }
    }
  }
  // Jobs assigned to simulated personas
  for (const j of all("SELECT * FROM jobs WHERE assigned_via = 'sim' AND status IN ('assigned','en_route','on_site')")) {
    if (!botControls(j.assigned_worker_id)) continue;
    const next = jobPlans.get(j.id + j.status) ?? now + rand(2000, 4000);
    jobPlans.set(j.id + j.status, next);
    if (now < next) continue;
    try {
      if (j.status === 'assigned') {
        // Scheduled jobs: a simulated persona starts only close to the slot.
        if (j.mode === 'schedule' && j.scheduled_at - now > 45 * 60000) continue;
        startJob(j.assigned_worker_id, j.id);
      } else if (j.status === 'en_route') {
        const w = get('SELECT * FROM workers WHERE id = ?', j.assigned_worker_id);
        if (haversineKm(w, j) * 1000 <= 40) arriveJob(j.assigned_worker_id, j.id);
      } else if (j.status === 'on_site') {
        const photos = Array.from({ length: j.proof_req.photos_min }, (_, i) => placeholderPhoto(j, i + 1));
        submitProof(j.assigned_worker_id, j.id, { photos, answers: botAnswers(j), simulated: true });
      }
    } catch { /* state moved on */ }
  }
}
