import { useState } from 'react';
import { api, ApiError, type FailureMode, type Order, type Tender } from '../api';
import { usePolling } from '../hooks';
import { centsToInput, formatCents, parseDollars } from '../money';

// Demo/probing panel. Only rendered when the backend runs with DEV_TOOLS=1
// (GET /api/dev/gateway answers); otherwise it renders nothing.
export function TestTools({ order }: { order: Order }) {
  const gateway = usePolling(api.devGateway, 1000);
  if (gateway.error?.status === 404 || (!gateway.data && gateway.error)) return null;

  return (
    <section className="card test-tools" aria-label="Test tools">
      <div className="test-tools-head">
        <h2>Test tools</h2>
        <span className="dev-tag">DEV_TOOLS</span>
      </div>
      <div className="test-tools-grid">
        <GatewayControls state={gateway.data} onChange={gateway.setData} />
        <PaymentRace order={order} />
        <RefundRace order={order} />
      </div>
    </section>
  );
}

const MODES: { mode: FailureMode; label: string; help: string }[] = [
  { mode: 'decline', label: 'Decline', help: 'Refused, nothing charged' },
  { mode: 'timeout', label: 'Timeout', help: 'No answer, nothing charged' },
  { mode: 'lost-response', label: 'Lose response', help: 'Charged, but the answer is lost' },
];

function GatewayControls({
  state,
  onChange,
}: {
  state: Awaited<ReturnType<typeof api.devGateway>> | null;
  onChange: (s: Awaited<ReturnType<typeof api.devGateway>>) => void;
}) {
  return (
    <div className="tool">
      <h3>Fake gateway</h3>
      <dl className="tool-stats">
        <div>
          <dt>Charges</dt>
          <dd className="money">{state?.charges ?? '–'}</dd>
        </div>
        <div>
          <dt>Refunds</dt>
          <dd className="money">{state?.refunds ?? '–'}</dd>
        </div>
      </dl>
      <p className="hint">
        Real money movements at the gateway (this color&apos;s process). After a lost response + Retry, these must go up by
        exactly one.
      </p>
      <div className="tool-buttons">
        {MODES.map((m) => (
          <button key={m.mode} type="button" className="btn btn-small" title={m.help} onClick={async () => onChange(await api.devFailNext(m.mode))}>
            {m.label} next
          </button>
        ))}
      </div>
      <p className="hint">
        Queued for the next card charge or refund:{' '}
        {state?.queued.length ? state.queued.map((q, i) => <span key={i} className="chip">{q}</span>) : 'nothing'}
      </p>
    </div>
  );
}

type Result = { label: string; count: number; ok: boolean };

// Fire `n` requests at the same moment and tally the outcomes,
// e.g. "201 created ×1, 422 OVERPAY ×9".
// `send` resolves to the id of the payment/refund the server returned.
async function race(n: number, send: (i: number) => Promise<string>) {
  const started = performance.now();
  const ids = new Set<string>();
  const outcomes = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      send(i).then(
        (id): [string, boolean] => {
          ids.add(id);
          return ['ok', true];
        },
        (e): [string, boolean] => [e instanceof ApiError ? `${e.status || 'network'} ${e.code}` : 'error', false],
      ),
    ),
  );
  const tally = new Map<string, Result>();
  for (const [label, ok] of outcomes) {
    const r = tally.get(label) ?? { label, count: 0, ok };
    r.count++;
    tally.set(label, r);
  }
  return { results: [...tally.values()], distinct: ids.size, ms: Math.round(performance.now() - started) };
}

function RaceResults({ run, noun }: { run: Awaited<ReturnType<typeof race>> | null; noun: string }) {
  if (!run) return null;
  return (
    <div className="race-results" role="status">
      {run.results.map((r) => (
        <span key={r.label} className={`chip ${r.ok ? 'chip-ok' : 'chip-err'}`}>
          {r.label} ×{r.count}
        </span>
      ))}
      <span className="hint">
        → {run.distinct} distinct {noun}
        {run.distinct === 1 ? '' : 's'} recorded · {run.ms} ms
      </span>
    </div>
  );
}

function PaymentRace({ order }: { order: Order }) {
  const [n, setN] = useState(10);
  // Empty = default to 60% of what's outstanding now: any one payment fits, no two do.
  const [amount, setAmount] = useState('');
  const [tender, setTender] = useState<Tender>('card');
  const [sameKey, setSameKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Awaited<ReturnType<typeof race>> | null>(null);

  const cents = parseDollars(amount) ?? Math.max(1, Math.ceil(order.outstanding_cents * 0.6));

  async function fire() {
    setBusy(true);
    const shared = crypto.randomUUID();
    setRun(await race(n, async () => (await api.pay(order.id, tender, cents, sameKey ? shared : crypto.randomUUID())).payment.id));
    setBusy(false);
  }

  return (
    <div className="tool">
      <h3>Race payments</h3>
      <p className="hint">
        {n} payments of {formatCents(cents, order.currency)} sent at once. Outstanding is{' '}
        {formatCents(order.outstanding_cents, order.currency)}: only the ones that fit may succeed.
      </p>
      <div className="tool-row">
        <NumberField label="Requests" value={n} onChange={setN} />
        <label className="field">
          <span>Each</span>
          <div className="input-money">
            <span aria-hidden="true">$</span>
            <input inputMode="decimal" placeholder={centsToInput(cents)} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </label>
        <label className="field">
          <span>Tender</span>
          <select className="select" value={tender} onChange={(e) => setTender(e.target.value as Tender)}>
            <option value="card">Card</option>
            <option value="cash">Cash</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={sameKey} onChange={(e) => setSameKey(e.target.checked)} />
        All with the same Idempotency-Key (a retry storm: expect one payment)
      </label>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={fire}>
        {busy ? 'Firing…' : `Fire ${n} at once`}
      </button>
      <RaceResults run={run} noun="payment" />
    </div>
  );
}

function RefundRace({ order }: { order: Order }) {
  const refundable = order.payments.filter((p) => p.refundable_cents > 0);
  const [paymentId, setPaymentId] = useState('');
  const [n, setN] = useState(10);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Awaited<ReturnType<typeof race>> | null>(null);

  const payment = refundable.find((p) => p.id === paymentId) ?? refundable[0];
  const cents = parseDollars(amount) ?? (payment ? Math.max(1, Math.ceil(payment.refundable_cents * 0.6)) : 0);

  async function fire() {
    if (!payment) return;
    setBusy(true);
    setRun(await race(n, async () => (await api.refund(order.id, payment.id, cents, crypto.randomUUID())).refund.id));
    setBusy(false);
  }

  return (
    <div className="tool">
      <h3>Race refunds</h3>
      {!payment ? (
        <p className="hint">Needs a captured tender with something left to refund.</p>
      ) : (
        <>
          <p className="hint">
            {n} refunds of {formatCents(cents, order.currency)} on one tender at once. Refundable is{' '}
            {formatCents(payment.refundable_cents, order.currency)}: only the ones that fit may succeed.
          </p>
          <div className="tool-row">
            <NumberField label="Requests" value={n} onChange={setN} />
            <label className="field">
              <span>Each</span>
              <div className="input-money">
                <span aria-hidden="true">$</span>
                <input inputMode="decimal" placeholder={centsToInput(cents)} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            </label>
            <label className="field">
              <span>Tender</span>
              <select className="select" value={payment.id} onChange={(e) => setPaymentId(e.target.value)}>
                {refundable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.tender} {formatCents(p.amount_cents, order.currency)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || cents <= 0} onClick={fire}>
            {busy ? 'Firing…' : `Fire ${n} at once`}
          </button>
        </>
      )}
      <RaceResults run={run} noun="refund" />
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="field field-narrow">
      <span>{label}</span>
      <input
        className="input-plain"
        type="number"
        min={1}
        max={50}
        value={value}
        onChange={(e) => onChange(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
      />
    </label>
  );
}
