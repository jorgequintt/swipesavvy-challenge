# Project — Split-Tender Payment Ledger (full stack + blue-green)
## Backend (Node/TypeScript or similar) + Postgres
* POST /orders — create an order with a total.
* POST /orders/:id/payments — apply a card/cash tender. Multiple tenders must sum to exactly the order total.
* POST /orders/:id/refunds — refund a specific prior payment; never more than was captured.
* GET /orders/:id — order state, all tenders, amount outstanding.
* GET /healthz — readiness check (used by the cutover).

## Frontend (React or your framework)
* Create an order and see it live.
* Add tenders against it; show running total vs. amount outstanding.
* Issue a refund against a specific tender.
* Show payment/refund history and current state.
* A visible version/color badge (reads blue or green from the backend) so the cutover is demonstrable on screen.
* The hard parts (left open on purpose — we want your judgement)
* Two payments hit the same order at the same instant and together overpay. Exactly one must win — how do you prevent the overpay (DB constraint, row lock, isolation level)?
* Money is never floating point — how do you store and total it?
* A refund lands on a payment that is being concurrently refunded — what happens?
* The gateway call "succeeds" but the response is lost before you record it — how do you keep a retry from double-charging (idempotency)?
* Blue-green deployment (required)
docker-compose (or similar) running two identical stacks — blue and green — behind one reverse proxy (nginx/Traefik/Caddy).
* A documented cutover: proxy points at blue, you deploy a change to green, flip traffic to green with no dropped requests, and can roll back to blue.
* A short script or clear README steps to run the flip. In the live demo you'll run it while the frontend badge switches blue→green with the app still working.

## What to hand in by the deadline
* Git repo (GitHub link or zip): frontend, backend, migration, compose files, proxy config.
* One-command run (docker-compose up) and one-command tests, documented in the README.
* Tests covering the success path and every error path, plus a concurrency test firing N parallel payments at one order.
* DECISIONS.md — each open question above and the blue-green approach: what you chose and why.
* A line on where (if anywhere) you used AI — we ask openly.