// A scripted buyer agent that talks MCP (JSON-RPC over /mcp) exactly like
// Claude / Grok / OpenAI would — no LLM, so every step is visible and repeatable.
import { h, mount, eur, icon } from '../public/js/common.js';

const KEY = 'ak_demo_milano';
let id = 0;
let session = null;

async function rpc(method, params) {
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${KEY}`,
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  session = res.headers.get('mcp-session-id') ?? session;
  return (await res.json()).result;
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { ok: !r.isError, data: r.structuredContent };
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = {
  shelf: {
    label: 'Verifica scaffale Esselunga',
    prompt: 'Controlla se il Pesto alla Genovese Barilla 190g è davvero a scaffale all\'Esselunga di Corso Vittorio Emanuele. Entro 2 ore, budget 13–22 €.',
    job: {
      title: 'Il Pesto alla Genovese Barilla 190g è a scaffale?',
      location: { address: 'Esselunga, Corso Vittorio Emanuele' },
      deadline_minutes: 120,
      instructions: ['Vai al reparto sughi pronti', 'Fotografa l\'intero lineare dei pesti', 'Fotografa da vicino il cartellino prezzo del Barilla 190g', 'Conta i facing visibili'],
      budget: { target_eur: 13, max_eur: 22 },
      agent_name: 'Claude (demo MCP)',
    },
  },
  capoeira: {
    label: 'Insegnante di Capoeira',
    prompt: 'Trovami un insegnante di Capoeira ai Navigli per stasera.',
    job: { title: 'Insegnante di Capoeira ai Navigli stasera', location: { address: 'Navigli' }, agent_name: 'Claude (demo MCP)' },
  },
};

export function mountAgent(root, { onOpenConfirm }) {
  let running = false;
  let scenario = 'shelf';
  const log = h('div.ag-log', { 'aria-live': 'polite' });
  const promptBox = h('div.ag-prompt');
  const runBtn = h('button.btn.primary', { onclick: () => run() }, 'Esegui l\'agente');
  const chips = h('div.chips');
  const drawChips = () => mount(chips, Object.entries(SCENARIOS).map(([k, s]) => h('button.chip', {
    class: k === scenario ? 'on' : '', disabled: running,
    onclick: () => { scenario = k; drawChips(); mount(promptBox, h('span.faint', {}, 'Utente → agente: '), `“${s.prompt}”`); },
  }, s.label)));
  drawChips();
  mount(promptBox, h('span.faint', {}, 'Utente → agente: '), `“${SCENARIOS[scenario].prompt}”`);

  const step = (kind, title, body) => {
    const el = h(`div.ag-step.${kind}`, {}, h('div.ag-k', {}, kind === 'call' ? 'tool call' : kind === 'result' ? 'risultato' : kind === 'err' ? 'fail-closed' : 'agente'), h('div.ag-t', {}, title), body ?? null);
    log.append(el);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return el;
  };
  const code = (obj) => h('pre.ag-json', {}, JSON.stringify(obj, null, 2));

  async function run() {
    if (running) return;
    running = true; runBtn.disabled = true; drawChips();
    mount(log);
    const s = SCENARIOS[scenario];
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-agent', version: '1' } });
      step('result', `initialize → ${init.serverInfo.name} · protocollo ${init.protocolVersion}`);
      const tools = await rpc('tools/list', {});
      step('result', `tools/list → ${tools.tools.length} tool`, h('div.ag-tools', {}, tools.tools.map((t) => h('code', {}, t.name))));
      await pause(500);

      step('call', 'create_job', code(s.job));
      const created = await call('create_job', s.job);
      if (!created.ok) {
        step('err', created.data.message, h('div.small.muted', {}, `${created.data.error} · ${created.data.detail ?? ''}`));
        step('agent', 'Rispondo all\'utente in modo onesto: Aronica non fa questo tipo di lavoro, nessuno viene promesso.');
        return;
      }
      const job = created.data.job;
      step('result', `Lavoro ${job.id} · ${job.skill_name} · ${created.data.match.eligible_workers} partner verificati disponibili`,
        h('div.ag-tools', {}, created.data.match.top.slice(0, 3).map((w) => h('code', {}, `#${w.rank} ${w.alias} · score ${w.score} · ${w.eta_min} min`))));
      await pause(400);

      // Negotiate: open low, then concede toward the best-value counter.
      let offer = 1300;
      let deal = null;
      for (let round = 1; round <= 6 && !deal; round++) {
        step('call', `negotiate · round ${round}`, code({ job_id: job.id, offer_eur: offer / 100 }));
        const r = await call('negotiate', { job_id: job.id, offer_eur: offer / 100 });
        step('result', `${r.data.responses.length} supplier agent hanno risposto`, h('div.ag-quotes', {}, r.data.responses.map((q) => h('div.ag-q', {},
          h('b', {}, q.alias), h('span', { class: `badge ${q.action === 'accept' ? 'green' : q.action === 'reject' ? 'red' : ''}` }, q.action),
          h('span.num', {}, eur(q.price_cents)), h('span.faint', {}, `${q.eta_min} min · score ${q.score}`)))));
        const top = [...r.data.responses].sort((a, b) => b.score - a.score)[0];
        if (r.data.best_accept && r.data.best_accept.worker_ref === top.worker_ref) {
          step('agent', `${top.alias} (miglior match) accetta ${eur(r.data.best_accept.price_cents)}. Blocco l'accordo.`);
          deal = r.data.best_accept;
        } else if (top.action === 'counter' && top.price_cents <= 2200 && (round >= 2 || r.data.best_accept)) {
          step('agent', `Preferisco il miglior match ${top.alias}: accetto la sua controproposta di ${eur(top.price_cents)}.`);
          deal = top;
        } else {
          const next = Math.min(2200, Math.round((offer + (top.price_cents - offer) * 0.6) / 50) * 50);
          step('agent', `Troppo alto. Rilancio a ${eur(next)}.`);
          offer = next;
        }
        await pause(300);
      }
      step('call', 'accept_quote', code({ job_id: job.id, quote_id: deal.quote_id }));
      const acc = await call('accept_quote', { job_id: job.id, quote_id: deal.quote_id });
      const d = acc.data.job.deal;
      step('result', `Accordo ${eur(d.price_cents)} · miglior match ${d.lead.alias} · arrivo in ${d.eta_min} min`, code({ status: acc.data.job.status, confirm_url: acc.data.confirm_url }));
      const m = /#\/job\/([^?]+)\?t=(.+)$/.exec(acc.data.confirm_url);
      step('agent', 'Gli agenti negoziano, gli umani confermano: invio il link di conferma all\'utente.',
        h('button.btn.primary', { style: { marginTop: '10px' }, onclick: () => onOpenConfirm(m[1], m[2]) }, icon('check'), 'Apri la conferma nel Buyer console'));
    } catch (e) {
      step('err', 'Errore', h('div.small', {}, e.message));
    } finally {
      running = false; runBtn.disabled = false; drawChips();
    }
  }

  mount(root,
    h('div.ag-side', {},
      h('h2', {}, 'Agent Connector'),
      h('p.muted', {}, 'Un agente AI (qui uno script, nessun LLM) usa i tool MCP di Aronica: crea il lavoro, negozia con i supplier agent dei partner e ottiene un link che un umano conferma con un tap.'),
      h('div.field', {}, h('span', {}, 'Scenario'), chips),
      h('div.card.flat.small', {}, promptBox),
      runBtn,
      h('div.sep'),
      h('h3', {}, 'Con il server reale'),
      h('p.small.muted', {}, 'Lo stesso endpoint MCP funziona con Claude Code, Claude Desktop, l\'API di Claude, OpenAI e Grok. Avvia il server del repository e collega:'),
      h('pre.ag-json', {}, 'claude mcp add --transport http aronica \\\n  http://localhost:8787/mcp \\\n  --header "Authorization: Bearer ak_demo_milano"'),
      h('p.small.muted', {}, 'Anche REST (/v1), OpenAPI 3.1 (/openapi.json) e schemi function-calling (/v1/tools.json).')),
    h('div.ag-main', {}, log, h('div.ag-empty.small.muted', {}, 'Premi “Esegui l\'agente” per vedere ogni chiamata MCP e le risposte dei supplier agent.')));
}
