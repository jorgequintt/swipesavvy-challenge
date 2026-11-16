# Split-Tender Payment Ledger

A point-of-sale payment ledger: create an order, pay it with any mix of card and cash
tenders that add up to exactly the total, refund specific tenders, and watch it all
live. It runs as two identical stacks (**blue** and **green**) behind one nginx proxy, and
traffic can be switched between them with no dropped requests.

- **Backend:** Node 24 + TypeScript, Express 5, plain `pg`, Postgres 16
- **Frontend:** React 19 + Vite, served by the backend
- **Proxy:** nginx 1.27
- **Tests:** Vitest + supertest against a real Postgres

Design decisions (overpay, money, concurrent refunds, idempotency, blue-green) are in
**[docs/DECISIONS.md](docs/DECISIONS.md)**.

---

## Run it (one command)

```bash
docker compose up
```

Open **http://localhost:8088**. The badge in the top-right corner shows which stack
served the page (`BLUE · v1` at first).

What starts:

| Service | What it is | Reachable at |
|---|---|---|
| `db` | Postgres 16 (shared by both colors) | `localhost:5434` (user/pass/db: `ledger`) |
| `migrate` | one-shot job that applies `db/migrations/*.sql`, then exits | n/a |
| `app-blue`, `app-green` | the same image: API + built frontend | only through the proxy |
| `proxy` | nginx, routes all traffic to the live color | `localhost:8088` |

The apps start only after `migrate` exits successfully, and the proxy starts only after
both apps pass their health check (`GET /healthz`, which checks the database).

## Test it (one command)

```bash
docker compose run --rm --build test
```

This builds the backend's build stage and runs **85 tests** against a separate
`ledger_test` database in the same Postgres. The test database is created and migrated
automatically.

| File | Covers |
|---|---|
| `money.test.ts` | cents parsing and validation (floats, strings, unsafe integers rejected) |
| `orders.test.ts` | create/get order, validation, 404s, malformed JSON |
| `payments.test.ts` | cash and card, split tenders, overpay, declines, every validation error, idempotent replay, key reuse, gateway timeout + retry, **lost response + retry charges once** |
| `refunds.test.ts` | partial/full refunds, cash vs card, tender swap, over-refund, refunding failed/pending/foreign payments, declines, replay, pending refunds, lost response |
| `concurrency.test.ts` | **N = 10 parallel payments** on one order (exactly one wins / exactly five fit), 10 parallel retries with one key, 10 parallel refunds on one payment, payments and refunds racing |
| `static.test.ts` | serving the frontend, SPA fallback, cache headers, API 404s stay JSON |
| `dev.test.ts` | the test-tools endpoint: absent unless enabled, queues gateway failures |

The concurrency tests are checked to **fail if the row lock is removed** (see
[DECISIONS.md](docs/DECISIONS.md#1-two-payments-at-the-same-instant-overpay)).

Locally, with the stack's `db` running: `cd backend && npm install && npm test`.

### Probe it from the UI

The local stack runs with `DEV_TOOLS=1`, which adds a **Test tools** panel under every
order (and the `/api/dev/gateway` endpoints behind it). It acts on the fake gateway of
whichever color is serving.

- **Fake gateway:** live charge/refund counters, and buttons that make the *next* card
  charge or refund **decline**, **time out** (nothing charged) or **lose its response**
  (charged, but the answer never arrives). Try: *Lose response next* → charge a card →
  it stays *pending* with a Retry button → Retry → captured, and the charge counter went up
  by exactly **one**.
- **Race payments:** fire N payments at the same instant. With the default amount (60% of
  what's outstanding) exactly one succeeds and the rest get `422 OVERPAY`. Tick *same
  Idempotency-Key* to simulate a retry storm: all succeed, but only **one** payment is recorded.
- **Race refunds:** fire N refunds at one tender: only what fits succeeds, the rest get
  `422 OVER_REFUND`.

Browsers send at most ~6 requests at once to one host, so the HTTP-level races are
gentler than in `concurrency.test.ts`, which also widens the race window with a test
hook. The panel shows the behaviour; the tests prove it.

Injecting payment failures is for demos only: production would run without `DEV_TOOLS`,
and then the panel and the endpoints don't exist.

---

## Blue-green cutover (runbook)

Two identical stacks, one proxy, one shared database. The proxy's upstream lives in
`proxy/active/upstream.conf`, and the scripts rewrite it and reload nginx gracefully.

### Deploy a change

1. **Starting state:** the proxy serves blue.
   ```bash
   ./scripts/flip.sh blue
   ```
2. **Make a change** in the code (anything visible, e.g. the header text in
   `frontend/src/App.tsx`).
3. **Optional but recommended: start load in a second terminal** to prove nothing drops:
   ```bash
   node scripts/load.mjs 60
   ```
4. **Deploy it to the idle color:**
   ```bash
   ./scripts/deploy.sh green v2
   ```
   The script:
   1. asks the proxy which color is live, and refuses to deploy onto it;
   2. runs migrations (expand-only, so blue keeps working on the same database);
   3. builds and starts **only** `app-green`, waiting until its health check passes;
   4. calls `flip.sh green`: health gate → swap the upstream → `nginx -t` → `nginx -s reload` → verifies the proxy now answers as green;
   5. records `GREEN_VERSION=v2` in `.env`.

   The badge on any open page switches to `GREEN · v2` within a couple of seconds, with
   a toast, while the page keeps working. Blue is never stopped or rebuilt.
5. **Roll back** (blue is still running the previous version):
   ```bash
   ./scripts/flip.sh blue
   ```

Next time, deploy to whichever color is idle (`./scripts/deploy.sh blue v3`).

### If something goes wrong

Every check runs **before** traffic moves:

| Failure | What happens |
|---|---|
| New code doesn't start or never gets healthy | `docker compose up --wait` fails → deploy stops, live color untouched |
| Migration fails | deploy stops before the new code starts (each migration runs in one transaction, so nothing is half-applied) |
| Target unhealthy at flip time | `flip.sh` refuses: "Traffic NOT moved" |
| Bad nginx config | `nginx -t` fails → the previous upstream file is restored |
| Proxy doesn't switch | `flip.sh` exits with an error after 5s instead of reporting success |

### Evidence: no dropped requests

`scripts/load.mjs` runs 8 concurrent workers that each loop over `GET /api/version`,
`POST /api/orders` and a payment (alternating card, which spends ~300ms inside the
simulated gateway call, and cash). It counts every non-2xx response and every network error.

Run on my machine during a rollback to blue and then a full rebuild-and-deploy to green:

```
requests: 8934   ok: 8934   failed: 0
answered /api/version by: { 'green v2': 2206, 'blue v1': 772 }
```

A deliberately broken release (the server throws on startup), deployed under load:
the deploy stopped at the health wait, blue kept serving, 3,750 requests, 0 failed.

---

## API

All endpoints are under `/api`. Money is always **integer cents**. Errors have one shape:

```json
{ "error": { "code": "OVERPAY", "message": "...", "details": { "outstanding_cents": 4000 } } }
```

| Method | Path | Body / headers | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/orders` | `{ total_cents, currency? }` | `201` order | `400` |
| `GET` | `/api/orders/:id` | n/a | `200` order with tenders, refunds, `paid_cents`, `pending_cents`, `outstanding_cents`, `status` | `404` |
| `POST` | `/api/orders/:id/payments` | `{ tender: "card"\|"cash", amount_cents }`, header **`Idempotency-Key`** | `201` new, `200` replay (`Idempotent-Replayed: true`) | `400`, `404`, `402 CARD_DECLINED`, `422 OVERPAY`, `422 IDEMPOTENCY_KEY_REUSED`, `504 GATEWAY_TIMEOUT` (retry with the same key) |
| `POST` | `/api/orders/:id/refunds` | `{ payment_id, amount_cents }`, header **`Idempotency-Key`** | `201` new, `200` replay | `400`, `404`, `402 REFUND_DECLINED`, `422 OVER_REFUND`, `422 PAYMENT_NOT_REFUNDABLE`, `422 IDEMPOTENCY_KEY_REUSED`, `504 GATEWAY_TIMEOUT` |
| `GET` | `/api/version` | n/a | `{ color, version }` (drives the badge) | n/a |
| `GET` | `/healthz` | n/a | `200` if the database answers, `503` otherwise | n/a |

Order `status` is derived, never stored: `open` (nothing paid), `partially_paid`, or
`paid` (paid in full with nothing still pending at the gateway).

---

## Repository layout

```
backend/
  src/
    app.ts            Express app (routes, error mapping, static frontend)
    server.ts         process entry: env, listen, graceful shutdown
    db.ts             pool + withTransaction()
    money.ts          cents validation / conversion
    orders.ts         order queries, lockOrder(), views
    payments.ts       payment flow (lock, reserve, gateway, finalize)
    refunds.ts        refund flow (same shape)
    gateway.ts        Gateway interface + FakeGateway (decline / timeout / lost-response)
    migrate.ts        migration runner (advisory lock, one transaction per file)
    routes/           HTTP layer: validation + status codes
  test/               Vitest suites (see above)
frontend/src/         React app: money.ts, hooks.ts (polling, idempotency keys), components/
db/migrations/        001_init.sql
proxy/                nginx config; active/upstream.conf = the live color
scripts/              flip.sh, deploy.sh, load.mjs
Dockerfile            3 stages: frontend build → backend build (also the test image) → runtime
docker-compose.yml    db, migrate, app-blue, app-green, proxy, test (profile)
```

## Developing

```bash
docker compose up -d              # db, both colors, proxy
cd frontend && npm install && npm run dev
```

The Vite dev server (http://localhost:5173) hot-reloads the UI and forwards `/api` to the
proxy on 8088, so the badge and flips work in development too.

---

## Where I used AI

I used Claude for:

- Planning: Discussing different strategies and planning the development roadmap 
- Frontend
- Unit tests
- Flip/deploy/load scripts
- Finding hidden bugs quickly
- Documentation (README.md and DECISIONS.md)
- Some functions
