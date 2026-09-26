// Shared public endpoints: app config, geocoding, proof media, cron tick.
import { get } from '../../core/db.js';
import { listServices } from '../../core/services.js';
import { CITY, GAZETTEER, VEHICLES, geocode, inServiceArea } from '../../core/geo.js';
import { RATING_TAGS, THRESHOLDS } from '../../core/reliability.js';
import { WEIGHTS, WEIGHT_LABELS_IT } from '../../core/matching.js';
import { BASE_URL } from '../../core/jobs.js';
import { HttpError, clock, NO_SUPPLY_IT } from '../../core/util.js';
import { json, safeEq } from '../http.js';
import { maybeTick } from '../runtime.js';

export function webRoutes(r) {
  r.get('/api/config', ({ res }) => json(res, 200, {
    city: CITY,
    places: GAZETTEER.map(({ name, lat, lng }) => ({ name, lat, lng })),
    services: listServices().map((s) => ({ code: s.code, segment: s.segment, name_it: s.name_it, description: s.description, params: s.params, proof: s.proof, flexible: !!s.flexible, multi_seat: !!s.multi_seat })),
    clock_offset_ms: clock.offset(),
    rating_tags: RATING_TAGS,
    vehicles: VEHICLES,
    weights: WEIGHTS,
    weight_labels: WEIGHT_LABELS_IT,
    thresholds: THRESHOLDS,
    no_supply_message: NO_SUPPLY_IT,
    base_url: BASE_URL(),
  }));
  r.get('/api/geocode', ({ res, url }) => {
    const g = geocode(url.searchParams.get('q') ?? '');
    json(res, 200, g ? { ...g, in_service_area: inServiceArea(g) } : { error: 'not_found' });
  });
  // Proof photos (stored in the database; ids are unguessable).
  r.get('/media/:id', async ({ res, params }) => {
    const m = await get('SELECT mime, data FROM media WHERE id = ?', params.id);
    if (!m) throw new HttpError(404, 'not_found', 'Not found');
    const headers = { 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=86400' };
    if (m.mime === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    res.end(Buffer.from(m.data, 'base64'));
  });
  // Backstop for the on-demand loop: a scheduler (Vercel cron, Supabase pg_cron)
  // pings this so offers expire and the cascade moves even with nobody watching.
  r.get('/api/tick', async ({ req, res, url }) => {
    const need = process.env.CRON_SECRET;
    const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key');
    if (need && !safeEq(String(got ?? ''), need)) throw new HttpError(401, 'unauthorized', 'Cron secret required');
    json(res, 200, { ticked: await maybeTick() });
  });
  r.get('/api/health', async ({ res }) => json(res, 200, { ok: true, db: !!(await get('SELECT 1 AS x')) }));
}
