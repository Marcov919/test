// Agent API (the connector's server side): REST generated from the tool list,
// MCP (Streamable HTTP), OpenAPI and OpenAI/xAI function schemas.
// Auth: Bearer API key (per assistant platform / per account).
import { TOOLS, callTool, accountFromKey, openAiTools } from '../../gateway/tools.js';
import { handleMcpHttp } from '../../gateway/mcp.js';
import { openApiSpec } from '../../gateway/openapi.js';
import { loadJob } from '../../core/jobs.js';
import { openSse, eventsForJob } from '../../core/events.js';
import { HttpError } from '../../core/util.js';
import { json, parseJson, bearer, queryArgs } from '../http.js';

export function agentRoutes(r) {
  for (const t of TOOLS) {
    const pattern = t.path.replace(/\{(\w+)\}/g, ':$1');
    r.add(t.method, pattern, async ({ req, res, url, params, body }) => {
      const account = await accountFromKey(bearer(req, url));
      if (!account) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <Aronica API key>. Demo key: ak_demo_milano');
      if (t.name === 'wait_for_update' && (req.headers.accept ?? '').includes('text/event-stream')) {
        const job = await loadJob(params.job_id);
        if (job.account_id !== account.id) throw new HttpError(404, 'job_not_found', 'Job not found');
        const since = Number(url.searchParams.get('since_seq') ?? req.headers['last-event-id'] ?? 0);
        return openSse(req, res, { since, fetch: (s) => eventsForJob(job.id, s) });
      }
      const args = { ...queryArgs(url), ...(t.method === 'POST' ? parseJson(body) : {}), ...params };
      json(res, t.name === 'create_job' ? 201 : 200, await callTool(account, t.name, args));
    });
  }
  r.get('/v1/tools.json', ({ res }) => json(res, 200, { tools: openAiTools() }));
  r.get('/openapi.json', ({ res }) => json(res, 200, openApiSpec()));
  r.post('/mcp', async ({ req, res, url, body }) => handleMcpHttp(req, res, body, await accountFromKey(bearer(req, url))));
  r.get('/mcp', async ({ req, res }) => handleMcpHttp(req, res, '', null));
  r.delete('/mcp', async ({ req, res }) => handleMcpHttp(req, res, '', null));
}
