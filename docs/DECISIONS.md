# Decisions

One rule runs through all of it:

> **Every transaction that changes money locks the order row first**
> (`SELECT … FROM orders WHERE id = $1 FOR UPDATE`), and the database enforces the
> money invariants itself with CHECK and UNIQUE constraints, as a safety net in case
> the application is modified without row-locking an order before changing money.

---

## 1. Two payments at the same instant overpay

**The problem.** "Check the outstanding amount, then insert the payment" is a race. Under
Postgres' default isolation (READ COMMITTED), two requests can both read "0 paid", both
pass the check, and both insert. A transaction on its own doesn't prevent this, and
neither does a CHECK constraint, because a CHECK can only see one row and can't add up
the payments table.

**Options I compared** (in a separate lab with 10 concurrent writers per strategy):

| Option | Result | Why not / why |
|---|---|---|
| Check, then insert, no lock | **overpaid** 10 of 10 times | the race itself |
| Read the counter in the app, write it back | **overpaid**, and the counter drifted from the ledger (lost update) | the app overwrites other writers' values |
| `SERIALIZABLE` isolation | correct | needs a retry loop around every transaction; without retries it rejected 4 of 5 *valid* payments; only safe if every writer uses it |
| Conditional `UPDATE … WHERE paid + x <= total` | correct | a good option, but puts the business rule inside a WHERE clause |
| **`SELECT … FOR UPDATE` on the order row** | correct | **chosen** |

**What I chose:** a row lock on the order, plus a running total guarded by a CHECK.

- The order row works as a mutex for that order's money. A second payment waits for the
  first to commit, then reads fresh data (READ COMMITTED takes a new snapshot per
  statement) and is either accepted or rejected with `422 OVERPAY`.
- Only writers to **the same order** queue up, which is never a bottleneck at a till.
  Reads (`GET /orders/:id`) never wait, because Postgres MVCC readers don't block.
- `orders.paid_cents` is a running total updated in the same transaction as the ledger
  rows, with `CONSTRAINT order_no_overpay CHECK (paid_cents BETWEEN 0 AND total_cents)`.
  Even if a future code path forgets the lock, the database refuses to store an overpaid order.
- `SET LOCAL lock_timeout = '5s'` means a request can't wait forever behind a stuck
  lock; it fails with `503 BUSY` instead.

**Never hold the lock during the gateway call: reserve, then confirm.**
```
tx 1 (short):  lock order → check → paid_cents += amount → INSERT payment 'pending' → COMMIT
               call the gateway                                (no lock, no open transaction)
tx 2 (short):  lock order → 'captured' | 'failed' (failed: paid_cents -= amount) → COMMIT
```
Pending card payments count against the outstanding amount, so money that's mid-flight
can't be taken twice.

**Proof.** `concurrency.test.ts` fires 10 parallel payments at one order: with 10 × 60%,
exactly one wins and nine get `OVERPAY`; with 10 × 20%, exactly five win and the order
lands on exactly 100%. My first version of this test **passed even with the lock
removed**, because the race window is microseconds wide and supertest's requests arrive
slightly staggered. So the tests install a hook that pauses 25ms between the check and the
write. With that in place, removing `FOR UPDATE` makes all the race tests fail. The losers then get
`CONSTRAINT_VIOLATION` instead of `OVERPAY`: the CHECK constraint still prevented the
overpay, but the tests assert the exact code so they can tell "the lock did its job"
apart from "only the safety net saved us."

---

## 2. Money is never floating point

`0.1 + 0.2 !== 0.3` in binary floating point, and the brief requires tenders to add up to
**exactly** the total. So:

- **Storage:** integer minor units (cents) in `bigint` columns. `$10.50` is `1050`.
- **API:** amounts are integers in cents (`amount_cents: 1050`). The server never parses
  `"10.50"`, so it never rounds. `parseCents` accepts only positive
  `Number.isSafeInteger` values; `10.5`, `"100"`, `NaN` and `2**53` get a `400`.
- **Database → JS:** node-postgres returns `bigint` as a **string** (not every bigint fits
  in a JS number). `centsFromDb` is the one place that converts, and it throws if a value
  were ever outside the safe range. Integer cents stay exact as JS numbers up to about
  $90 trillion.
- **"Totalling" it:** sums are integer arithmetic on cents: the running totals in
  SQL, and the order view's derived `outstanding_cents = total − paid`.
- **UI:** the only place dollars exist. `"19.99"` → `1999` is parsed **as text**, never
  `Number(x) * 100` (`19.99 * 100 = 1998.9999999999998`). Formatting builds the string from
  the integer parts.
- Each order has a `currency` (ISO 4217). Splitting a total N ways would hand out the
  leftover cents explicitly (3333 + 3333 + 3334), not round.

---

## 3. A refund lands on a payment that is being refunded at the same time

**What happens:** both refund requests take the **same order lock** that payments use.
The second one waits for the first to commit, then reads the payment's `refunded_cents`,
which includes the first refund even if that one is still pending at the gateway. If
there's still room for its amount, it goes through. Otherwise it gets
`422 OVER_REFUND` with `refundable_cents` in the details. A payment is never refunded
beyond what was captured.

- The backstop is `CONSTRAINT payments_no_over_refund CHECK (refunded_cents BETWEEN 0 AND amount_cents)`.
- I don't take a second `FOR UPDATE` on the payment row. Every writer of an order's
  payments already holds the order lock, so it would add nothing, and one lock with
  one ordering rule (order first) can't deadlock. I hit that deadlock in the lab: inserting
  a child row takes a light lock on its parent, and upgrading that lock afterwards
  deadlocks two transactions.
- Only `captured` payments are refundable (`422 PAYMENT_NOT_REFUNDABLE` otherwise; also
  enforced by `payments_refund_only_captured`). A payment from another order returns `404`,
  and the composite foreign key `refunds(payment_id, order_id) → payments(id, order_id)`
  makes that impossible at the database level too.

**The counters move conservatively,** each in the direction that can't break its CHECK:

| Event | `orders.paid_cents` | `payments.refunded_cents` |
|---|---|---|
| refund created (pending) | unchanged: the balance does **not** reopen yet | `+ amount`: refundable room is used up now |
| refund succeeded | `− amount`: now the order owes this again | unchanged |
| refund failed | unchanged | `− amount`: room given back |

If a pending refund reopened the balance immediately, a cashier could take a new
payment against it, and then if the refund failed, putting the money back would push the
order over its total. Cash refunds succeed on the spot (the money leaves the drawer).
Because refunds reopen the balance, a **tender swap** works: refund part of the card,
then take cash.

---

## 4. The gateway call succeeds but the response is lost

The customer *was* charged, but we never heard back. If the cashier retries, a naive
system charges them twice. I use idempotency at two layers.

**Layer 1: client → API.** Every `POST /payments` and `POST /refunds` requires an
`Idempotency-Key` header. The frontend generates one per *attempt* and reuses it when
retrying the same attempt, and only then.

- Keys are scoped per order: `UNIQUE (order_id, idempotency_key)`.
- They're checked **under the order lock**, so ten simultaneous retries with the same key
  queue up and find the first one's row.
- Same key, same body → the original result is replayed (`200`, `Idempotent-Replayed: true`).
- Same key, different body → `422 IDEMPOTENCY_KEY_REUSED`, detected with a SHA-256
  fingerprint of the request.
- The UNIQUE constraint is the backstop.

**Layer 2: API → gateway.**

1. **Write intent first.** The `pending` row is committed *before* the gateway is called,
   so even a crash leaves a durable "a charge may have happened" record.
2. **The gateway gets its own idempotency key:** `payment:<payment id>`. Any retry of
   the same request maps to the same payment row, hence the same gateway key, and an
   idempotent gateway returns the original charge instead of making a new one.
3. **A timeout means "unknown", not "failed".** The payment stays `pending`, the money
   stays reserved, and the API answers `504 GATEWAY_TIMEOUT`: retry with the same key.
   The retry finds the pending row and calls the gateway again with the same gateway key.
4. **Finalizing is guarded:** `UPDATE … SET status = 'captured' WHERE id = $1 AND status = 'pending'`,
   so a payment moves from pending to final exactly once, even if two retries finish
   at the same moment.

The fake gateway can simulate `decline`, `timeout` (nothing charged) and
`lost-response` (charged, then the answer is "lost"). The lost-response tests check that the
gateway's charge count stays at **one** after the retry, for payments and for refunds.

**In production** I'd add a reconciliation job: pending rows older than N seconds whose
client never retried get resolved by asking the gateway by key, so their reservation isn't
held forever.

---

## 5. Blue-green deployment

**Topology:** two identical app stacks, one nginx, **one shared Postgres**. With
separate databases, orders created on blue would disappear after a flip to green.

**The flip** (`scripts/flip.sh`):
1. health-check the target;
2. write `server app-<color>:3000 resolve;` to `proxy/active/upstream.conf`
   (temp file + rename);
3. `nginx -t`, and restore the previous file if the config is invalid;
4. `nginx -s reload`. A reload starts new workers on the new config while old workers
   **finish their in-flight requests**. A restart would drop connections;
5. poll `/api/version` until the proxy really answers as the target, or exit with an error.

**The deploy** (`scripts/deploy.sh <color> <version>`): refuse if the target is live
(asking the proxy, not trusting the file) → migrate → build and start **only** the idle
color with `--no-deps --wait` → flip → record the version label in `.env`. The live
color is never stopped or rebuilt, so **rollback is just a flip**. Each color builds its own
image, so the old one is still there.

**Migrations are expand-only.** They run while the old color is still serving on the same
database, and rollback means the old code runs against the new schema. So a release can
add tables or nullable columns, but never drop or rename something the previous release
uses; that "contract" step ships in a later release. Migrations run as a one-shot
`migrate` service (not on app startup, where both colors would race), take a Postgres
advisory lock so two runners can't apply the same file twice, and run each file in one
transaction (Postgres DDL is transactional).

**Graceful shutdown:** on `SIGTERM`, the server stops accepting connections, finishes
in-flight requests, closes the pool, and force-exits after 10s. The Dockerfile uses the
exec form `CMD ["node", …]` so node actually receives the signal.

**Evidence** (`scripts/load.mjs`, 8 workers, reads plus order and payment writes):
8,934 requests during a rollback and a rebuild-and-deploy, **0 failed**. A broken release
(crashes on start) stopped at the health wait, with 3,750 requests during it, 0 failed.

---

## Smaller decisions

- **API under `/api`.** The same Express app serves the frontend, and the page route
  `/orders/:id` would otherwise collide with `GET /orders/:id`. Unknown `/api/*` routes
  return JSON 404s; any other GET returns the app shell.
- **Caching:** `index.html` is `no-cache` so the browser picks up a new release after a
  flip; Vite's fingerprinted assets are `immutable`.
- **Order status is derived** from `paid_cents`, `pending_cents` and `total_cents`, never
  stored, so it can't disagree with the numbers.
- **UUID ids** (`gen_random_uuid()`): order URLs can't be guessed or enumerated.
  Malformed ids return `404`, not a Postgres type error.
- **Status columns are `text` + CHECK**, not Postgres ENUMs, because adding or removing a
  value is a plain constraint swap, which suits expand/contract migrations.
- **Live updates by polling** every second: simple, survives the flip transparently, and
  good enough for a till. SSE would be the next step.
- **Status codes:** `400` malformed input, `404` unknown resource, `402` declined,
  `422` business rule broken, `504` unknown gateway outcome (safe to retry), `503` busy.
- **Tests run against a real Postgres.** Locks and constraints are the point, and a mock
  can't exercise them. Test files run one at a time because they share one database.

## Known limitations / next steps

- **The fake gateway is in memory, one per process.** Blue and green each have their own,
  so a card payment left `pending` on one color and retried after a flip would be charged
  again on the other color's fake gateway. A real gateway is a shared external service, so
  this only affects the fake.
- **No reconciliation job yet** for pending payments whose client never retries (see §4).
- **Cash overtender** (customer hands over $50 for $42) is rejected rather than recorded
  with `change_due`.
- **A fully refunded order shows `open`**; a derived `refunded` status would be clearer.
- **No auth and no frontend unit tests.** Gateway failures and concurrent requests can be
  triggered from the UI through a `DEV_TOOLS`-only test panel; that switch must stay off
  in production.
- **Database credentials should not be stored as plain text** in the Docker compose file.
  They are added into the file for convenience.