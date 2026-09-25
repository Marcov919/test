// Scripted agents that talk MCP (JSON-RPC over /mcp) exactly like Claude /
// Grok / OpenAI would — no LLM, so every call is visible and repeatable.
import { h, mount, eur, icon } from '../public/js/common.js';

let rpcId = 0;
function client(key) {
  let session = null;
  const rpc = async (method, params) => {
    const res = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    return (await res.json()).result;
  };
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { ok: !r.isError, data: r.structuredContent }; };
  return { rpc, call };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = {
  week: {
    label: 'Assistente personale · la mia settimana',
    who: 'Assistente personale (chiave privato)',
    key: 'ak_demo_milano',
    prompt: 'Organizzami la settimana. Tra le cose da fare: sistemare il giardino (sono circa 80 mq, c\'è anche la siepe). Sabato mattina va bene, abito ai Navigli.',
    text: 'sistemare il giardino sabato mattina, circa 80 mq con la siepe, zona Navigli',
  },
  fiera: {
    label: 'Agente acquisti · 4 facchini in Fiera',
    who: 'Agente di Aurora Eventi (chiave azienda, approvazione automatica fino a €600)',
    key: 'ak_demo_business',
    prompt: 'Per l\'allestimento del nostro stand a Fiera Milano Rho servono 4 facchini venerdì dalle 7 alle 12.',
    text: 'Servono 4 facchini venerdì 7-12 alla Fiera di Rho per allestimento stand',
  },
  capoeira: {
    label: 'Richiesta fuori ambito',
    who: 'Assistente personale',
    key: 'ak_demo_milano',
    prompt: 'Trovami un insegnante di Capoeira ai Navigli per stasera.',
    text: 'Trovami un insegnante di Capoeira ai Navigli per stasera',
  },
};

export function mountAgent(root, { onOpenConfirm }) {
  let running = false;
  let scenario = 'week';
  const log = h('div.ag-log', { 'aria-live': 'polite' });
  const promptBox = h('div.ag-prompt');
  const runBtn = h('button.btn.primary', { onclick: () => run() }, 'Esegui l\'agente');
  const chips = h('div.chips');
  const drawPrompt = () => mount(promptBox, h('div.xs.faint', {}, SCENARIOS[scenario].who), h('div', { style: { marginTop: '4px' } }, h('span.faint', {}, 'Utente → agente: '), `“${SCENARIOS[scenario].prompt}”`));
  const drawChips = () => mount(chips, Object.entries(SCENARIOS).map(([k, s]) => h('button.chip', {
    class: k === scenario ? 'on' : '', disabled: running, onclick: () => { scenario = k; drawChips(); drawPrompt(); },
  }, s.label)));
  drawChips(); drawPrompt();

  const step = (kind, title, body) => {
    const el = h(`div.ag-step.${kind}`, {}, h('div.ag-k', {}, { call: 'tool call', result: 'risultato', err: 'fail-closed', agent: 'agente' }[kind]), h('div.ag-t', {}, title), body ?? null);
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
    const { rpc, call } = client(s.key);
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-agent', version: '1' } });
      step('result', `initialize → ${init.serverInfo.name} ${init.serverInfo.version}`);
      const tools = await rpc('tools/list', {});
      step('result', `tools/list → ${tools.tools.length} tool`, h('div.ag-tools', {}, tools.tools.map((t) => h('code', {}, t.name))));
      await pause(400);

      step('call', 'compile_task', code({ text: s.text }));
      const comp = await call('compile_task', { text: s.text });
      if (!comp.ok) {
        step('err', comp.data.message, h('div.small.muted', {}, comp.data.detail ?? comp.data.error));
        step('agent', 'Rispondo all\'utente in modo onesto: questo Aronica non lo fa, nessuno viene promesso.');
        return;
      }
      const c = comp.data;
      step('result', `${c.service.name} · ${c.window.label} · ${c.headcount > 1 ? `${c.headcount} persone · ` : ''}${eur(c.price.total_cents)} prezzo fisso`,
        h('div.ag-tools', {}, Object.entries(c.params).map(([k, v]) => h('code', {}, `${k}: ${v}`)), c.questions.map((q) => h('code', { style: { background: '#fff4de' } }, q.q))));
      if (c.questions.length) step('agent', `Confermo con l'utente le ipotesi (${c.questions.map((q) => q.key).join(', ')}): ok.`);
      await pause(400);

      step('call', 'create_job', code({ text: s.text }));
      const created = await call('create_job', { text: s.text, agent_name: s.who.split(' (')[0] });
      if (!created.ok) { step('err', created.data.message, h('div.small.muted', {}, created.data.detail ?? '')); return; }
      const job = created.data.job;
      step('result', `Lavoro ${job.id} · ${created.data.supply.available_in_window} partner liberi nella fascia`,
        h('div.ag-tools', {}, created.data.supply.top.slice(0, 4).map((w) => h('code', {}, `#${w.rank} ${w.alias}${w.kind === 'business' ? ` (squadra ${w.crew_available})` : ''} · score ${w.score}`))));
      await pause(300);

      step('call', 'negotiate', code({ job_id: job.id }));
      const neg = await call('negotiate', { job_id: job.id });
      step('result', `${neg.data.responses.length} supplier agent hanno risposto sul quando · ${neg.data.seats_available}/${neg.data.headcount} posti disponibili`,
        h('div.ag-quotes', {}, neg.data.responses.map((q) => h('div.ag-q', {},
          h('b', {}, q.alias), h('span', { class: `badge ${q.action === 'accept' ? 'green' : q.action === 'counter' ? 'warn' : 'red'}` }, q.action),
          h('span', {}, q.slot_label ?? '—'), h('span.faint', {}, q.seats > 1 ? `${q.seats} posti` : q.message.slice(0, 40))))));
      const pick = neg.data.best_accept ?? neg.data.earliest_counter;
      if (!pick) { step('err', 'Nessuna disponibilità', h('div.small', {}, neg.data.hint)); return; }
      step('agent', neg.data.best_accept ? `Scelgo ${pick.alias}: miglior match libero ${pick.slot_label}.` : `Nessuno libero nella fascia: propongo all'utente ${pick.slot_label} (${pick.alias}).`);
      step('call', 'accept_quote', code({ job_id: job.id, quote_id: pick.quote_id }));
      const acc = await call('accept_quote', { job_id: job.id, quote_id: pick.quote_id });
      if (!acc.ok) { step('err', acc.data.message); return; }
      const j = acc.data.job;
      const m = /#\/job\/([^?]+)\?t=(.+)$/.exec(j.confirm_url);
      if (acc.data.auto_approved) {
        step('result', `Approvato dalla policy aziendale · stato ${j.status}`, code({ approval: j.approval, slot: j.slot?.label, price: eur(j.price.total_cents) }));
        await pause(1800);
        const ev = await call('wait_for_update', { job_id: job.id, since_seq: 0, timeout_s: 0 });
        const sent = ev.data.events.filter((e) => e.type === 'dispatch.offer_sent');
        step('result', `wait_for_update → ${sent.length} offerte a tempo inviate in parallelo`, h('div.ag-tools', {}, sent.map((e) => h('code', {}, `${e.data.alias}${e.data.seats > 1 ? ` × ${e.data.seats}` : ''}`))));
        step('agent', 'Nessun tap umano sotto soglia. Seguo i posti che si riempiono e i contratti generati.',
          h('button.btn.primary', { style: { marginTop: '10px' }, onclick: () => onOpenConfirm(m[1], m[2], 'business') }, icon('briefcase'), 'Segui i posti nel Buyer console'));
      } else {
        step('result', `Slot bloccato ${j.deal.slot_label} · in attesa di conferma umana`, code({ status: j.status, confirm_url: j.confirm_url }));
        step('agent', 'Gli agenti negoziano, gli umani confermano: invio il link all\'utente.',
          h('button.btn.primary', { style: { marginTop: '10px' }, onclick: () => onOpenConfirm(m[1], m[2], 'consumer') }, icon('check'), 'Apri la conferma nel Buyer console'));
      }
    } catch (e) {
      step('err', 'Errore', h('div.small', {}, e.message));
    } finally {
      running = false; runBtn.disabled = false; drawChips();
    }
  }

  mount(root,
    h('div.ag-side', {},
      h('h2', {}, 'Agent Connector'),
      h('p.muted', {}, 'Un agente AI (qui uno script, nessun LLM) usa i tool MCP di Aronica: compila l\'incarico, lo crea, negozia il quando con i supplier agent e ottiene lo slot. Per i privati conferma un umano; per le aziende decide la policy.'),
      h('div.field', {}, h('span', {}, 'Scenario'), chips),
      h('div.card.flat.small', {}, promptBox),
      runBtn,
      h('div.sep'),
      h('h3', {}, 'Con il server reale'),
      h('p.small.muted', {}, 'Lo stesso endpoint MCP funziona con Claude Code, Claude Desktop, l\'API di Claude, OpenAI e Grok:'),
      h('pre.ag-json', {}, 'claude mcp add --transport http aronica \\\n  http://localhost:8787/mcp \\\n  --header "Authorization: Bearer ak_demo_milano"'),
      h('p.small.muted', {}, 'Anche REST (/v1), OpenAPI 3.1 (/openapi.json) e schemi function-calling (/v1/tools.json).')),
    h('div.ag-main', {}, log, h('div.ag-empty.small.muted', {}, 'Scegli uno scenario e premi “Esegui l\'agente”: vedi ogni chiamata MCP e le risposte dei supplier agent.')));
}
