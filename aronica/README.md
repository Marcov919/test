# Aronica (v1.1, Milano)

Aronica is the physical hand of your personal AI assistant (Instinct, Muse, Grok, Claude, ChatGPT). When software can't finish a task, Aronica sends a verified local person or small business: a car wash near your home, someone waiting for the technician, a pick-up at the pharmacy.

1. Agents turn the request into a precise task with a **fixed price**.
2. Supplier agents negotiate only the **slot**.
3. You confirm with one tap (**Adesso** or **Programma**), like Uber.
4. A timed offer goes to the best partner and cascades to the next one if needed.
5. The partner sends **photo + GPS proof**.

When nobody is available, Aronica says so and never fakes a match.

## Run

```bash
cd aronica
npm start            # http://localhost:8787 — seeds Milano on first run (older DBs are reseeded automatically)
npm test             # 26 tests: compiler, car-wash hero flow, cascade, fail-closed, pricing, reliability, MCP, REST
npm run demo:agent -- --confirm   # scripted assistant books the car wash over REST
npm run seed         # wipe + reseed
npm run build:demo   # single-file offline demo → dist/aronica-demo.html (whole product in one page)
```

Requirements: Node ≥ 22.5. There are **zero runtime dependencies** (`node:sqlite`, `node:http`, vanilla JS); devDependencies are used only by `build:demo`.

| Surface | URL | |
|---|---|---|
| Home | `/` | "Cosa ti serve, a Milano?" |
| Consumer (Live) | `/buyer` | Examples, compiled task, **available partners**, A2A on the slot, **Adesso / Programma**, live status, proof, rating. *Aziende · sperimentale* is a secondary tab |
| Partner app | `/worker` | Pick a seed profile (e.g. **Wash&Go Navigli Snc**), online/offline toggle, full-screen timed offer **Accetto / Rifiuto**, Parti → Sono arrivato → photo proof |
| Agent Connector | `/mcp`, `/v1`, `/openapi.json`, `/v1/tools.json`, `/docs` | MCP + REST for Claude, ChatGPT/OpenAI, Grok, any tool-using agent |
| Ops | `/ops` | **Ranking explained** per partner, offers with TTL, cascade, reliability, event log, demo clock |

## Demo script: the car wash (two tabs)

1. `npm start`, then open **two tabs**: `http://localhost:8787/worker` and `http://localhost:8787/buyer`.
2. **Worker tab:** under *Attività*, pick **Wash&Go Navigli Snc**. You are online.
3. **Buyer tab:** click the first example, **Auto all'autolavaggio**. The sentence *"Porta la mia auto all'autolavaggio sabato mattina e riportamela — Navigli, berlina, interno+esterno."* compiles to:
   - task: *Lavaggio auto berlina · interno + esterno · ritiro e riconsegna*
   - slot: Saturday 08:00–13:00 (flexible start)
   - price: **€58 fixed**
   - proof: photos of the plate, the car before and after, and interiors or return, plus GPS
4. Below the task you see **3 available partners** (`search_supply`), ranked, each saying how they do the job:
   - Wash&Go Navigli: a driver picks the car up
   - AutoSpa Porta Romana
   - Luca F.: mobile wash trailer, the car doesn't move

   You can switch to **Adesso** (ASAP within 3h, +30% short notice) or stay on **Programma**.
5. **Blocca uno slot con i partner** runs the live A2A negotiation on the slot. Then press **Conferma e programma · €58**.
6. **Worker tab:** the timed offer appears within ~1s with a 20s ring. Press **Accetto**. The buyer tab shows *"Wash&Go Navigli Snc è confermato/a"*.
7. **Worker tab:** press **Parti ora** and the buyer tab shows *"… è in viaggio"* with ETA on the map. Then press **Sono arrivato**, then **Carica la prova** (4 photos + checklist). The buyer tab shows **Fatto**, the labelled photos, and the rating.
8. **Cascade:** repeat, but press **Rifiuto** (or let the 20s expire). The offer goes to #2, the buyer tab says *"… ha rifiutato: offerta al partner successivo"*, and Ops shows `declined → pending`. If every partner declines, the job ends as `no_match` with the honest message and the escrow stub is refunded.
9. **Fail-closed:** try the example **Insegnante di Capoeira (fallisce)**. You get *"Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta."* with the reason **fuori ambito v1**, and no partner is contacted.
10. **Ops:** the *Classifica* shows why Wash&Go is #1: proximity, rating, reliability, service fit and acceptance, the excluded partners with reasons, and the offer outcome.

The single-page demo (`dist/aronica-demo.html`) contains the same flow with the partner phone next to the buyer console. The phone follows the offer, including the cascade after a *Rifiuto*. Its **Agente AI** tab runs the car-wash scenario through the real MCP tools, so nobody types any field.

## Product model

- **Primary intents** ("mi sblocca la giornata"):
  1. car wash: pick-up and return via an autolavaggio, or a mobile wash
  2. waiting at home for a technician or courier
  3. local pick-up and drop-off (pharmacy, keys, envelope), **max 3 km**
  4. IKEA assembly or small handyman jobs

  Gardening, cleaning and purchase errands are still in the catalog but are not headline stories.
- **Task compiler** (`compile_task`, `src/compiler.js`) is deterministic and needs no LLM. It turns Italian or English text into:
  - service and typed params (vehicle, wash type, pick-up yes/no, …)
  - window
  - duration
  - fixed price with breakdown
  - proof (named shots)
  - open questions
  - `mode`: `now` (Adesso) or `scheduled` (Programma)
- **Fixed platform price** (`src/pricing.js`) with explicit surcharges: less than 3h notice +30%, less than 24h +15%, Sunday or after 20:00 +10%. The fee is 15%. Agents negotiate **when**, never price.
- **Supply check** (`search_supply`): the partners who are actually free and accept the pay, ranked. "0 available" is shown as-is.
- **A2A on the slot** (`src/negotiation.js`): each partner's supplier agent checks its weekly calendar and bookings, then replies with one of:
  - accept
  - counter with another slot
  - decline
- **Dispatch** (`src/dispatch.js`) works like this:
  - A timed offer (TTL 20s, adjustable in Ops) goes to #1.
  - Accept claims the job.
  - Decline or timeout moves the offer to the next partner.
  - When the list is exhausted there is one rescan, then `no_match` with the honest message and an escrow refund.
- **Ranking** (`src/matching.js`) is kept simple and shown in Ops:

  | Factor | Weight |
  |---|---|
  | proximity | 30% |
  | rating | 25% |
  | reliability (completion, no-shows) | 20% |
  | service fit (jobs done in this service) | 15% |
  | acceptance | 10% |

  Hard filters: verified, active, does the service, within 18 km, free in the slot, accepts the fixed pay. A warning-tier partner loses 12 points.
- **Reliability** (Uber-like):
  - rating = the last 100 ratings with a Bayesian prior; tags such as "not the partner's fault" are excluded
  - warning tier below ★4.6, suspension below ★4.4, below 80% completion, or after 3 no-shows
- **Relationship with the partner:** Aronica does **matching, dispatch and proof** and is not the employer. The consumer-facing label is "partner con P.IVA · fattura al cliente (stub)" or "partner privato · ricevuta occasionale (stub)".

## Seed data (Milano)

There are 18 partners. The ones that matter for the consumer path:

- **Wash&Go Navigli Snc**: car-wash business, crew of 3, open Mon–Sat 8–19, ★4.95, 640 washes. It wins the happy path.
- **AutoSpa Porta Romana Srl**: car-care business, crew of 2, open every day 8–20.
- **Luca F.**: mobile car wash with a trailer (plus IKEA assembly).
- Presence and errand partners:
  - **Giulia R.**, the Brera handyman who is also #1 for IKEA
  - **Ahmed K.**
  - **Sara M.**
  - Marco B.
  - Elena P.
- Reliability edge cases:
  - Davide C. is warning-tier
  - Francesca L. is suspended
  - Chiara V. is pending verification
  - Paolo G. works weekends only
- **Zero supply** for lessons, teachers or lifestyle services (Capoeira and similar), which fail closed.

The experimental business supply (Rho Staff Service, Verde Navigli, Pulito Brera, event staff) serves only the *Aziende · sperimentale* tab.

## What is simulated (and labelled as such)

- **Supplier agents** run server-side, in the same process.
- **Seed partners**: any profile not open in `/worker` answers offers according to its historical acceptance rate. It moves toward the job (accelerated 30×) and uploads placeholder photos marked **FOTO SIMULATA**. A profile opened in the app is driven only by you. Real signed-up partners are never simulated. The simulator can be switched off in Ops.
- **The demo "Agente AI"** is a script that calls the real MCP tools. **No LLM is wired in.** The MCP endpoint works with real agents:

  ```bash
  claude mcp add --transport http aronica http://localhost:8787/mcp --header "Authorization: Bearer ak_demo_milano"
  ```
- **Stubs:**
  - escrow and payments: no real charge
  - KYC/KYB document checks: Ops verifies the partner by hand
  - partner invoices and receipts: drafts
  - the demo clock (Ops) can jump ahead in time
- **Maps:** Leaflet from a CDN when reachable, otherwise a built-in stylised offline map of Milano.

## Agent Connector

One tool list (`src/connector.js`) is exposed as MCP (Streamable HTTP at `/mcp`, plus the stdio bridge `bin/aronica-mcp-stdio.js`), REST (`/v1`), OpenAPI 3.1 and OpenAI/xAI function schemas. The tools are:

- `list_services`
- `compile_task`
- `search_supply`
- `create_job`
- `negotiate` / `auto_negotiate`
- `accept_quote`
- `get_job`
- `list_jobs`
- `wait_for_update`
- `cancel_job`
- `rate_worker`

Demo key: `ak_demo_milano`. An experimental company key, `ak_demo_business`, has auto-approval up to €600.

Lifecycle: `scheduling → pending_confirmation → dispatching → assigned → in_progress → done`. The other end states are `no_match`, `expired` and `cancelled`.

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

## Known limits

- Worker login is a persona picker; there is no SMS OTP.
- The geocoder is a Milano gazetteer. Agents can always send `lat`/`lng`.
- The Ops console is open unless `ARONICA_OPS_TOKEN` is set.
- Proof photo URLs are unguessable but not access-controlled.
