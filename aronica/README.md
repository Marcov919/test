# Aronica

Aronica is the physical hand of a personal AI assistant, in Milano. When software can't finish a task, the assistant asks Aronica and a verified local person or small business does it. Typical asks: "get my car washed on Saturday", "wait for the technician at my place", "pick up my prescription".

How a job runs:

- The job gets a **fixed price**.
- Agents negotiate only the **slot**.
- The human confirms with **one tap**, choosing **Adesso** or **Programma**.
- A **timed offer** goes to the best partner; if they decline, it **cascades** to the next one.
- The partner sends **photo + GPS proof**.

When nobody is available, Aronica says so and never fakes a match.

## Architecture

Three products share one platform:

| | What | Where | Talks to |
|---|---|---|---|
| **Agent connector** (demand side) | The contract assistant platforms integrate: MCP tools, REST, OpenAPI, function schemas. It also includes the connector's UI: the confirm card and the confirm page opened by `confirm_url` | `gateway/` · `/mcp`, `/v1/*` · `public/confirm/` | Agent API (API key) · Confirm API (per-job token) |
| **Partner app** (supply side) | PWA for people and small businesses: online toggle, timed offer, Accetto / Rifiuto, go → arrive → proof | `public/partner/` | Partner API `/partner/v1/*` (partner session) |
| **Ops** (internal) | Explained ranking, offers and TTL, cascade, reliability, verification, demo clock, API keys | `public/ops/` | Ops API `/api/ops/*` (`ARONICA_OPS_TOKEN`) |

Shared layers:

- **Core** (`core/`) holds the domain logic: task compiler, fixed pricing, matching, A2A slot negotiation, dispatch with cascade, reliability, and a simulator for the seed partners.
- **Server** (`server/`) is one request handler with one route file per API area. It runs as a single Vercel Function (`api/index.js`) or as a local Node server (`server/local.js`).
- **Database**: Postgres in production (Supabase), SQLite locally, and PGlite to test the Postgres dialect. The data layer is async, so the same code runs on all three.

The **simulated assistant** (`public/assistant/` + `/api/assistant/*`) is **not part of the product**. It stands in for the assistant's own app and servers (Muse, Instinct, ChatGPT…) so the demo shows the real consumer experience: a chat where Aronica's cards appear. Its backend keeps the API key on the server and calls Aronica through the same tool layer MCP clients use. Its "agent" is a script, with no LLM.

### Runtime without a background process

Serverless instances are short-lived and share nothing except the database:

- **Events** are stored in Postgres. SSE streams and long-polls read new events from the database. A stream closes after about 55s and `EventSource` resumes it with `Last-Event-ID`.
- **The dispatch loop** covers offer expiry, cascade, no-shows and the simulator. It runs on demand: after requests, inside open streams, and from an optional cron ping (`/api/tick`). A compare-and-set on `settings.last_tick` lets only one instance tick at a time.
- **Concurrency**: accept, confirm and `fillSeats` lock the job row (`SELECT … FOR UPDATE`). The negotiation lock is a compare-and-set.
- **Demo clock and presence** live in the database:
  - demo clock offset: `settings.clock_offset_ms`
  - partner app heartbeat: `workers.app_seen_at`
  - real GPS: `workers.real_gps`
- **Simulator decisions** are derived from record ids, so every instance agrees.
- **Proof photos** go to the `media` table and are served at `/media/:id`.

## Run locally

```bash
cd aronica
npm install
npm start          # http://localhost:8787 — SQLite in data/aronica.db, seeded on first run
npm test           # 26 tests on SQLite
npm run test:pg    # the same tests on Postgres (PGlite)
npm run seed       # wipe + reseed
```

The start command prints these pages:

- **Simulated assistant:** `/assistant/`
- **Partner app:** `/partner/`
- **Confirm page:** `/confirm/`
- **Ops:** `/ops/`
- **Connector docs:** `/docs/`

To use Postgres locally, set `DATABASE_URL=postgres://…`.

## Deploy (Vercel + Supabase, free tiers)

**1. Supabase.** The project `aronica` (Frankfurt) is already set up:

- a private schema `aronica`, which is not exposed through the Data API;
- a login role `aronica_app` that owns it.

The app migrates and seeds itself on the first request. Connect through the transaction pooler (port 6543), with user `aronica_app.<project-ref>`.

**2. Vercel.** Import the GitHub repository with these settings:

- **Root Directory:** `aronica`
- **Framework:** Other
- **Production Branch:** the branch you deploy, in Settings → Git

Everything else comes from `vercel.json`:

- `public/` is served by the CDN;
- the API is one function in `fra1`, next to the database;
- the rewrites send `/v1`, `/mcp`, `/api`, `/partner/v1` and `/media` to it.

**3. Environment variables:**

| Variable | |
|---|---|
| `DATABASE_URL` | `postgres://aronica_app.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`. You can list several URLs separated by `\|`; the first one that answers wins. Useful if you are unsure which pooler host (aws-0 / aws-1) serves the project. |
| `ARONICA_OPS_TOKEN` | Protects Ops. Open `/ops/?token=<value>` once in the browser. |
| `CRON_SECRET` | Optional. Protects `/api/tick` for an external scheduler. |
| `ASSISTANT_API_KEY` | Optional. The key the simulated assistant uses (default `ak_demo_milano`). |
| `ARONICA_PUBLIC_URL` | Optional. By default, `confirm_url` uses the Vercel production domain. |

**4. Optional backstop.** A scheduler calls `GET /api/tick?key=<CRON_SECRET>` every minute, for example Supabase `pg_cron` + `pg_net`. Offers then expire even when nobody has a page open.

## Demo script: the car wash, on two devices

1. **Phone:** open `/partner/` and choose **Wash&Go Navigli Snc** (under *Attività*). You are online. You can install it as an app from the browser menu.
2. **Computer:** open `/assistant/`, tap the suggestion **Auto all'autolavaggio** and send it. The assistant:
   - compiles the task: berlina, interno + esterno, ritiro e riconsegna, sabato mattina, **€58 fixed**;
   - shows three available partners and how each one does it:
     - Wash&Go Navigli: a driver picks the car up
     - AutoSpa Porta Romana
     - Luca F.: mobile wash trailer
   - offers two options: **Adesso** (+30%, within 3h) or **Programma**.
3. Tap **Programma**. The supplier agents agree on the slot and the Aronica **confirm card** appears. Tap **Conferma e programma · €58**.
4. **Phone:** the timed offer arrives within about 1 second, with a 20-second ring. Tap **Accetto**. The chat says *"Wash&Go Navigli Snc ha accettato"*.
5. **Phone:** tap **Parti ora**, then **Sono arrivato**, then upload the 4 photos (targa, prima, dopo, riconsegna). The chat shows **Fatto**, the labelled photos and the stars.
6. **Cascade:** repeat and tap **Rifiuto** instead. The chat says *"Il partner ha rifiutato: passo al successivo"*. The next partner (simulated) accepts.
7. **Fail-closed:** ask for *"un insegnante di Capoeira"*. You get the honest message with the reason **fuori ambito v1**, and no partner is contacted.
8. **Ops** (`/ops/?token=…`) shows the ranking behind every offer and the event log. **Vai al prossimo lavoro** moves the demo clock to the next scheduled job, so you can watch the simulated partners work.

## What is simulated

- **The simulated assistant** and its agent: a script with no LLM, labelled in the UI.
- **Supplier agents** run server-side and answer from the seed calendars.
- **Seed partners** that nobody has open in the app answer offers according to their acceptance rate, move toward the job (30× speed), and upload photos marked **FOTO SIMULATA**. A profile open in the partner app is left alone.
- **Escrow and payments** are stubs: no real charge. **KYC/KYB** is a stub: Ops verifies partners by hand. **Partner invoices and receipts** are drafts. Aronica does matching, dispatch and proof; it is not the employer.
- **Coverage:** Milano only, using a small gazetteer. Agents can send `lat`/`lng`.

## Agent connector

The same tools are available as MCP (`/mcp`, Streamable HTTP; plus `bin/aronica-mcp-stdio.js`), REST (`/v1`), OpenAPI 3.1 (`/openapi.json`) and OpenAI/xAI function schemas (`/v1/tools.json`):

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

Demo key: `ak_demo_milano`. To try it end to end, run `npm run demo:agent -- --confirm`.

Business staffing (event crews, `ak_demo_business`) is still in the engine and tests as an experiment. It is not on the consumer path.
