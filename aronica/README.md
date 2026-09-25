# Aronica: Agent→Human dispatch (Milano, v2)

Aronica is the physical step of an agentic flow, and it serves two kinds of buyer:

- **Personal assistants.** An assistant that plans your week turns "sistemare il giardino" into a booked gardener, and "stasera ho un evento, qualcuno mi compri un jeans" into an errand with a purchase cap.
- **Company agents.** A procurement or ops agent books one-shot staff, for example "4 facchini venerdì 7-12 in Fiera Rho", and the booking is auto-approved under company policy.

Every booking gets verified partners at a fixed price, with A2A negotiation on *when*. The right contract is generated for each person, and a no-show is replaced automatically.

```bash
cd aronica
npm start            # http://localhost:8787 — seeds Milano demo data on first run
npm test             # 21 tests: compiler, pricing, matching, seats, contracts, no-show, MCP, REST
npm run demo:agent -- --confirm   # scripted assistant + company agent over REST
npm run seed         # wipe + reseed
npm run build:demo   # single-file offline demo → dist/aronica-demo.html
```

Requirements:

- Node ≥ 22.5.
- **Zero runtime dependencies**: it runs on `node:sqlite`, `node:http` and vanilla JS.
- devDependencies are only used to build the single-file demo.
- Map: Leaflet from a CDN when it is reachable, otherwise a built-in offline map of Milano.

| Surface | URL | Who |
|---|---|---|
| Buyer console | `/buyer` | Private person or company (switch *Privato / Azienda*). Describe the need, edit the compiled task, see the WHEN negotiation, confirm, follow seats → proof → rating / invoice |
| Worker / Business app | `/worker` | Partner (person or business with a crew): timed full-screen offer, **Accetto / Rifiuto**, slot, contract, check-in/out or photo proof |
| Agent Connector | `/mcp`, `/v1`, `/openapi.json`, `/v1/tools.json`, `/docs` | Claude, Grok, OpenAI, any tool-using agent |
| Ops | `/ops` | Live map, jobs and seats, assignments and contracts, reliability, verification, **demo clock** (jump to next job), **simulate no-show**, API keys |

Demo API keys:

- `ak_demo_milano`: personal assistant; a human confirms.
- `ak_demo_business`: Aurora Eventi & Hospitality Srl; auto-approval up to €600.

## The v2 model

1. **Task compiler** (`compile_task`, `src/compiler.js`). It turns a vague intent into a structured job:
   - service and typed params (m², hedge, number of items, headcount, shift, article, spending cap…)
   - the time window, parsed from Italian and English: "sabato mattina", "venerdì 7-12", "entro le 19", "dalle 9 alle 13"
   - the duration, the proof type and the instructions
   - the **open questions** the agent should confirm with its user

   It fails closed on anything out of scope.
2. **Fixed platform price** (`src/pricing.js`). Pricing is transparent and nobody haggles:
   - per-service formula
   - explicit surcharges: less than 3h notice +30%, less than 24h +15%, Sunday or after 20:00 +10%
   - a 15% fee
   - a pre-authorised purchase hold for errands
3. **A2A negotiation on WHEN** (`src/negotiation.js`). Each supplier agent checks its partner's weekly calendar and current bookings, then answers `accept` (start time, seats it can cover), `counter` (another slot) or `decline` (for example, pay below the partner's minimum). Price is never negotiated.
4. **Approval.** Consumers get a `confirm_url` for a one-tap human confirm. Business accounts are auto-approved by policy up to `auto_approve_max_cents`; above that, a human confirms.
5. **Seats in parallel** (`src/dispatch.js`):
   - one timed offer per open seat, highest score first
   - business partners can cover several seats with their crew
   - concentration cap: with 4+ people, at most half the seats go to one supplier, so a single no-show cannot sink the shift
   - when supply runs out, coverage is honest: `no_match`, or partial coverage with a proportional refund
6. **Contract routing** (`src/compliance.js`). Each assignment gets:
   - `fattura_b2b` for a business with a VAT number
   - `presto` (Libretto Famiglia / Contratto di prestazione occasionale) or `occasionale_privato` for individuals, checked against indicative caps: €5,000 per worker, €10,000 per buyer, €2,500 per worker–buyer pair, and ≤10 employees for companies
   - otherwise `somministrazione` through a partner agency

   **These are indicative stubs, not legal advice.**
7. **Guarantee.** No-show detection runs at start + 20 min, followed by automatic replacement offers (a late arrival is allowed within half the job). Workers who cancel reopen their seat.
8. **Proof.** Home services use photos with a GPS geofence. Shifts use a check-in/check-out timesheet, with auto-checkout at the end of the shift. Business jobs get an invoice draft (IVA 22%). Escrow is a stub: no real money moves.

Lifecycle:

- `scheduling → pending_confirmation → dispatching → assigned → in_progress → done`
- other end states: `no_match`, `expired`, `cancelled`; partial coverage stays `assigned` with `seats_filled < headcount` and a proportional refund

Assignments go through `assigned → en_route → on_site → done`, with the extra states `no_show` and `cancelled`.

## Agent Connector

A single tool list (`src/connector.js`) is exposed four ways:

- **MCP (Streamable HTTP)** at `POST /mcp` with `Authorization: Bearer <key>`. Supported protocol versions: 2025-06-18, 2025-03-26 and 2024-11-05.
  - Claude Code: `claude mcp add --transport http aronica http://localhost:8787/mcp --header "Authorization: Bearer ak_demo_milano"`
  - Claude Desktop / Cursor: the stdio bridge `bin/aronica-mcp-stdio.js`
  - Claude API MCP connector, OpenAI Responses remote MCP, xAI remote MCP: a public `https://…/mcp` plus `ARONICA_PUBLIC_URL`
- **REST** under `/v1` (see `/docs`), with long-poll or SSE events at `/v1/jobs/:id/events`
- **OpenAPI 3.1** at `/openapi.json`
- **OpenAI/xAI function schemas** at `/v1/tools.json`

Tools: `list_services`, `compile_task`, `search_supply`, `create_job`, `negotiate`, `auto_negotiate`, `accept_quote`, `get_job`, `list_jobs`, `wait_for_update`, `cancel_job`, `rate_worker`.

## Product rules

- **Fail closed, honestly.** These cases return exactly *"Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta."*:
  - lessons, beauty, medical, and certified plumbing, electrical or boiler work (Capoeira, nails, dentist…)
  - other cities
  - places outside the service area
  - nobody capable
- **Matching (Uber-style).**
  - Hard filters: verified; not suspended; has the service; within 18 km; the partner's minimum rate fits; free at the slot (weekly availability, busy load vs capacity); online for jobs within 2h; warning tier kept off jobs above €150.
  - Score: distance .25, rating .25, reliability .20, experience .15, timing .10, acceptance .05. Warning tier −12.
- **Reliability (modelled on Uber).**
  - Two-way ratings, averaged over a rolling window of the last 100 with a Bayesian prior.
  - Ratings tagged "not the worker's fault" are excluded.
  - Warning and suspension tiers; Ops can reinstate.
  - A no-show counts heavily.
- **Verification.** New partners stay `pending_verification` until Ops verifies them (the KYC/KYB check is a stub).

## Seed data (Milano)

There are 17 partners:

- **Giulia R.** (Brera, ★4.97) is the clear #1 for handyman, assembly and errands in the centre.
- **Verde Navigli Snc** (crew of 3) leads gardening.
- **Rho Staff Service Srl** (crew of 6, next to the Fiera) leads facchinaggio and event staff.
- Davide C. is warning-tier and Francesca L. is suspended.
- Paolo G. works weekends only and Chiara V. is pending verification.

## Demo simulator (clearly labelled)

Seed personas without an open app answer offers according to their historical acceptance rate. They move toward the task and submit placeholder photos marked **FOTO SIMULATA** (`proof.simulated = true`).

Open `/worker` as a persona and the simulator stops driving that persona. You are that partner. Real signed-up workers are never simulated.

The simulator can be turned off in Ops. Movement is simulated unless the app streams real GPS (toggle in the worker profile).

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` | 8787 | |
| `ARONICA_DB` | `data/aronica.db` | SQLite file |
| `ARONICA_UPLOADS` | `data/uploads` | proof photos |
| `ARONICA_PUBLIC_URL` | `http://localhost:$PORT` | used in `confirm_url` and OpenAPI `servers` |
| `ARONICA_TICK_MS` | 2000 | cascade loop interval |
| `ARONICA_NEG_DELAY_MS` | 800 | supplier-agent think time (live feel) |
| `ARONICA_OPS_TOKEN` | unset | if set, `/api/ops/*` requires `X-Ops-Token` |

## Known v1 limits

- Worker login is a persona picker. There is no SMS OTP provider.
- The geocoder is a Milano gazetteer. Agents can always send `lat`/`lng`.
- Supplier agents run server-side (the PRD allows this).
- The Ops console is open unless `ARONICA_OPS_TOKEN` is set.
- Proof photo URLs are unguessable but not access-controlled.
