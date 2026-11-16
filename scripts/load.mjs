// Steady traffic through the proxy, counting every failed request. Run it while
// deploying or flipping to show that the cutover drops nothing.
//
//   node scripts/load.mjs [seconds=30] [workers=8]
//
// Each worker loops: GET /api/version (which color answered?), create an order,
// pay it (alternating card and cash, so some requests are mid-gateway-call when
// the flip happens). Exits with code 1 if anything failed.

const BASE = process.env.PROXY_URL ?? 'http://localhost:8088';
const seconds = Number(process.argv[2] ?? 30);
const workers = Number(process.argv[3] ?? 8);
const end = Date.now() + seconds * 1000;

const stats = { ok: 0, failed: 0, byColor: {}, errors: {} };
let lastColor = '?';

async function call(method, path, body, headers = {}) {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      stats.ok++;
      return data;
    }
    count(`HTTP ${res.status} ${data?.error?.code ?? ''}`.trim());
  } catch (err) {
    count(err.cause?.code ?? err.message); // e.g. ECONNREFUSED, ECONNRESET
  }
  return null;
}

function count(reason) {
  stats.failed++;
  stats.errors[reason] = (stats.errors[reason] ?? 0) + 1;
}

async function worker(id) {
  for (let i = 0; Date.now() < end; i++) {
    const v = await call('GET', '/api/version');
    if (v?.color) {
      const label = `${v.color} ${v.version}`;
      stats.byColor[label] = (stats.byColor[label] ?? 0) + 1;
      lastColor = label;
    }
    const order = await call('POST', '/api/orders', { total_cents: 1000 });
    if (order?.id) {
      const tender = (i + id) % 2 ? 'card' : 'cash';
      await call('POST', `/api/orders/${order.id}/payments`, { tender, amount_cents: 1000 }, {
        'Idempotency-Key': crypto.randomUUID(),
      });
    }
  }
}

const started = Date.now();
const ticker = setInterval(() => {
  const t = Math.round((Date.now() - started) / 1000);
  console.log(`${String(t).padStart(3)}s  ok=${stats.ok}  failed=${stats.failed}  serving=${lastColor}`);
}, 1000);

await Promise.all(Array.from({ length: workers }, (_, id) => worker(id)));
clearInterval(ticker);

console.log('\n--- result');
console.log(`requests: ${stats.ok + stats.failed}   ok: ${stats.ok}   failed: ${stats.failed}`);
console.log('answered /api/version by:', stats.byColor);
if (stats.failed) console.log('failures:', stats.errors);
process.exit(stats.failed ? 1 : 0);