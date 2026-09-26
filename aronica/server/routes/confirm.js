// Confirm API: what the connector's confirm card (inside the assistant) and the
// fallback confirm page (/confirm, the confirm_url) use. Auth = the per-job
// secret token carried by confirm_url; no account, no API key in the browser.
import { loadJob, serializeJob, rateWorker } from '../../core/jobs.js';
import { acceptQuote, autoNegotiate, quotesForJob } from '../../core/negotiation.js';
import { confirmJob, buyerCancel } from '../../core/dispatch.js';
import { openSse, eventsForJobStream, lastSeq, emit } from '../../core/events.js';
import { HttpError, iso } from '../../core/util.js';
import { json, parseJson, safeEq } from '../http.js';

export async function jobWithToken(jobId, t) {
  const job = await loadJob(jobId);
  if (!safeEq(job.confirm_token, t ?? '')) throw new HttpError(403, 'invalid_token', 'Invalid or missing job token');
  return job;
}

export function confirmRoutes(r) {
  r.get('/api/jobs/:id', async ({ res, url, params }) => {
    const job = await jobWithToken(params.id, url.searchParams.get('t'));
    const quotes = (await quotesForJob(job.id)).map((q) => ({ ...q, created_at: iso(q.created_at), slot_start: iso(q.slot_start) }));
    json(res, 200, { job: await serializeJob(job, { buyer: true, events: true }), quotes });
  });
  // Runs the round within this request (the platform's buyer agent); the page
  // follows it live over the stream.
  r.post('/api/jobs/:id/auto-negotiate', async ({ res, url, params }) => {
    const job = await jobWithToken(params.id, url.searchParams.get('t'));
    try {
      const out = await autoNegotiate(job.id);
      json(res, 200, { ok: true, deal: out.deal ?? null, auto_approved: !!out.auto_approved });
    } catch (e) {
      await emit('negotiation.failed', { job_id: job.id, data: { message: e.message } });
      throw e;
    }
  });
  r.post('/api/jobs/:id/accept-quote', async ({ res, url, params, body }) => {
    await jobWithToken(params.id, url.searchParams.get('t'));
    json(res, 200, await acceptQuote(params.id, String(parseJson(body).quote_id ?? ''), { actor: 'buyer_human' }));
  });
  r.post('/api/jobs/:id/confirm', async ({ res, url, params }) => {
    await jobWithToken(params.id, url.searchParams.get('t'));
    const job = await confirmJob(params.id, { by: 'human' });
    json(res, 200, { job: await serializeJob(job, { buyer: true }) });
  });
  r.post('/api/jobs/:id/cancel', async ({ res, url, params, body }) => {
    await jobWithToken(params.id, url.searchParams.get('t'));
    json(res, 200, await buyerCancel(params.id, parseJson(body).reason));
  });
  r.post('/api/jobs/:id/rating', async ({ res, url, params, body }) => {
    await jobWithToken(params.id, url.searchParams.get('t'));
    json(res, 200, await rateWorker(params.id, parseJson(body)));
  });
  r.get('/api/jobs/:id/stream', async ({ req, res, url, params }) => {
    const job = await jobWithToken(params.id, url.searchParams.get('t'));
    const hdr = req.headers['last-event-id'] ?? url.searchParams.get('since');
    const since = hdr != null ? Number(hdr) : await lastSeq();
    return openSse(req, res, { since, fetch: (s) => eventsForJobStream(job.id, s) });
  });
}
