// Minimal, spec-conformant MCP server (Streamable HTTP transport, JSON
// responses). Works with Claude Code / Claude Desktop (via stdio bridge),
// OpenAI Responses API remote MCP, xAI remote MCP tools, and any MCP client.
import { TOOLS, callTool } from './tools.js';
import { HttpError, token } from '../core/util.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'aronica', title: 'Aronica — hire verified people in Milano', version: '0.2.0' };

const INSTRUCTIONS = `Aronica is the physical hand of a personal AI assistant in Milano: when software can't finish, it dispatches a verified local person or small business, at a fixed price, with proof. Main uses: car wash (pick-up & return or mobile wash), waiting at home for a technician/courier, local pick-up & drop-off (pharmacy, keys, envelope; max 3 km), IKEA assembly/small handyman. Business staffing is experimental.
Flow: compile_task (user's words → structured job with FIXED price and open questions; confirm them with the user) → search_supply (who is actually available, ranked) → create_job → negotiate / auto_negotiate (supplier agents reply on WHEN: accept, counter-slot, decline) → accept_quote → give confirm_url to your human (one tap; mode now = Adesso, scheduled = Programma) → wait_for_update → get_job (proof) → rate_worker.
Out-of-scope (e.g. lessons/teachers like Capoeira), other cities or no available partners fail closed with an honest message and a reason. Never promise a person before a partner has accepted. Supplier agents, escrow and KYC are simulated/stubbed in this build.`;

function rpcResult(idv, result) { return { jsonrpc: '2.0', id: idv, result }; }
function rpcError(idv, code, message, data) { return { jsonrpc: '2.0', id: idv ?? null, error: { code, message, ...(data ? { data } : {}) } }; }

async function handle(msg, account) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined;
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'initialize': {
      const v = SUPPORTED.includes(p.protocolVersion) ? p.protocolVersion : SUPPORTED[0];
      return rpcResult(msg.id, {
        protocolVersion: v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })),
      });
    case 'tools/call': {
      if (!account) return rpcError(msg.id, -32001, 'Unauthorized: send Authorization: Bearer <aronica api key>');
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
      try {
        const out = await callTool(account, p.name, p.arguments ?? {});
        return rpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
          isError: false,
        });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(e);
        const err = e instanceof HttpError
          ? { error: e.code, message: e.message, ...e.extra }
          : { error: 'internal_error', message: 'Internal error' };
        return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(err, null, 2) }], structuredContent: err, isError: true });
      }
    }
    case 'resources/list':
      return rpcResult(msg.id, { resources: [] });
    case 'prompts/list':
      return rpcResult(msg.id, { prompts: [] });
    default:
      if (isNotification) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcpHttp(req, res, body, account) {
  if (req.method === 'GET') {
    // No server-initiated stream in v1.
    res.writeHead(405, { Allow: 'POST, DELETE' });
    return res.end();
  }
  if (req.method === 'DELETE') {
    res.writeHead(204);
    return res.end();
  }
  let parsed;
  try { parsed = JSON.parse(body || 'null'); } catch {
    return send(res, 400, rpcError(null, -32700, 'Parse error'));
  }
  const headers = {};
  const batch = Array.isArray(parsed);
  const msgs = batch ? parsed : [parsed];
  if (msgs.some((m) => m?.method === 'initialize')) headers['Mcp-Session-Id'] = token(12);
  const out = (await Promise.all(msgs.map((m) => handle(m, account)))).filter(Boolean);
  if (!out.length) { res.writeHead(202, headers); return res.end(); }
  return send(res, 200, batch ? out : out[0], headers);
}

function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}
