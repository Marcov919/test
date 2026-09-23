# Aronica — Agent→Human dispatch (Milano v1)

AI assistants hire verified people and businesses for physical field-proof tasks. They negotiate live with supplier agents, a human confirms with one tap (Now / Schedule), and the work is dispatched right away through a timed Uber-style cascade.

```bash
cd aronica
npm start            # http://localhost:8787 — seeds Milano demo data on first run
npm test             # 17 tests: matching, cascade, negotiation, reliability, proof, MCP, REST
npm run demo:agent -- --confirm   # scripted buyer agent runs the whole lifecycle over REST
npm run seed         # wipe + reseed
```

Requires Node ≥ 22.5. There are **zero npm dependencies**: it uses `node:sqlite`, `node:http` and vanilla JS. The map uses Leaflet + CARTO tiles from a CDN and falls back to a built-in offline stylised map of Milano when the CDN is unreachable.

| Surface | URL | Who |
|---|---|---|
| Buyer console | `/buyer` | Human operator: create a request or open an agent's `confirm_url`, watch the A2A negotiation, **Conferma**, track to *Fatto*, rate |
| Worker / Business app | `/worker` | Partner (person or business): go online, get a full-screen timed offer, **Accetto / Rifiuto**, navigate, upload proof |
| Agent Connector | `/mcp`, `/v1`, `/openapi.json`, `/v1/tools.json`, `/docs` | Claude, Grok, OpenAI, any tool-using agent |
| Ops | `/ops` | Platform: live map, reliability tiers, verification queue, cascade, event log, simulator, API keys |

Demo API key: `ak_demo_milano`.

## Agent Connector

A single tool definition list (`src/connector.js`) is exposed four ways:

- **MCP (Streamable HTTP)** at `POST /mcp` with `Authorization: Bearer <key>`. Supports protocol versions 2025-06-18, 2025-03-26 and 2024-11-05.
  - Claude Code: `claude mcp add --transport http aronica http://localhost:8787/mcp --header "Authorization: Bearer ak_demo_milano"`
  - Claude Desktop / Cursor: stdio bridge `bin/aronica-mcp-stdio.js` (env `ARONICA_URL`, `ARONICA_API_KEY`)
  - Claude API MCP connector, OpenAI Responses remote MCP, xAI remote MCP: point them at a public `https://…/mcp` and set `ARONICA_PUBLIC_URL`
- **REST** under `/v1` (see `/docs`), with long-poll or SSE events at `/v1/jobs/:id/events`
- **OpenAPI 3.1** at `/openapi.json` (Custom GPT Actions, codegen)
- **OpenAI/xAI function schemas** at `/v1/tools.json`

Tools: `list_skills`, `search_workers`, `create_job`, `negotiate`, `auto_negotiate`, `accept_quote`, `get_job`, `list_jobs`, `wait_for_update`, `cancel_job`, `rate_worker`.

Lifecycle: `negotiating → pending_confirmation → dispatching → assigned → en_route → on_site → done`. The other end states are `no_match`, `expired` and `cancelled`.

**Agents negotiate; humans confirm.** `accept_quote` returns a `confirm_url` holding a per-job secret token. The human opens it and taps *Conferma*. There is no agent-side confirm tool.

## Product rules implemented

- **Fail closed, honestly.** These cases return exactly *"Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta."*:
  - unknown skills
  - lifestyle requests (Capoeira teacher, nails, dentist…), unless that skill is later added to the `skills` table
  - other cities, or places outside the service area
  - no available verified workers (at intake, at confirm, or when the cascade runs out)
- **Pre-structured tasks.** Every job carries a deadline, step-by-step instructions, pay and proof requirements (min photos, GPS geofence, checklist questions). Workers never get a vague chat.
- **Matching (Uber-style).** Hard filters come first: verified, active, online, has the skill, spare capacity, within 12 km, can make the deadline, and the supplier floor fits the budget. Workers who pass are scored:
  - ETA 35%, rating 25%, completion 15%, skill experience 10%, price fit 10%, acceptance 5%
  - a warning-tier worker loses 12 points
  - every candidate carries a score breakdown.
- **A2A negotiation.** One supplier agent per top-5 worker, each with a private floor (base × worker rate × urgency × distance) and a concession curve. Every step is persisted (`quotes` and `events`) and streamed live over SSE.
  - The built-in buyer agent never exceeds max and trades a little price for match quality.
  - The deal pool is every eligible worker who would work at the agreed price, ranked by score.
- **Cascade.** Confirm creates an offer to #1 with `expires_at = now + TTL` (20s, adjustable in Ops). A loop runs every 2s:
  - it expires unanswered offers and moves to the next worker
  - Accept claims the job atomically and cancels any other pending offers
  - an exhausted pool triggers one rescan for newly online workers, then `no_match` with the honest message and an escrow refund
  - if a worker cancels after accepting, the job goes back into the cascade.
- **Reliability (modelled on Uber).**
  - Two-way ratings. The rating is the average of the last 100 rated jobs, with a Bayesian prior for new workers.
  - Ratings tagged "not the worker's fault" are excluded.
  - Warning tier (below ★4.6, <90% completion or >5% cancellations): ranked lower, no jobs above €50, and a banner in the app.
  - Suspension (below ★4.4 over ≥10 ratings, <80% completion, or 3 no-shows): removed from matching, with the reasons shown. Ops can reinstate.
  - Acceptance rate barely counts; completion and no-shows matter.
- **Verification.** New signups (people or businesses with a P.IVA) stay `pending_verification` and cannot go online until Ops verifies them. The KYC/KYB check is a stub.
- **Payments.** Escrow is a stub: `held` at confirm, `released` on verified proof, `refunded` or `partially_released` (30% fee once en route) on cancel. No real money moves.

## Seed data (Milano)

There are 14 partners: 11 people and 3 businesses (FotoPunto Srl, Rapido Pony Express, Studio Rilievi Navigli).

- **Giulia R.** (Brera, bike, ★4.97, 99% completion) is the clear #1 for shelf and store tasks near the Duomo.
- Davide C. is warning-tier and Francesca L. is suspended.
- Chiara V. is pending verification, Paolo G. is offline, and Elena P. is new with 3 ratings.

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
