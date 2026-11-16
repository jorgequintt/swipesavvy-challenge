import { useState, type FormEvent } from 'react';
import { api, type Order, type Tender } from '../api';
import { useAttemptKey } from '../hooks';
import { centsToInput, formatCents, parseDollars } from '../money';
import { Feedback, feedbackFor, useFeedback } from './Feedback';

export function TenderForm({ order, onUpdated }: { order: Order; onUpdated: (o: Order) => void }) {
  const [tender, setTender] = useState<Tender>('card');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useFeedback();
  const attempt = useAttemptKey();
  const fmt = (c: number) => formatCents(c, order.currency);
  const done = order.outstanding_cents === 0;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const cents = parseDollars(amount);
    if (cents === null) {
      setFeedback({ kind: 'error', text: 'Enter an amount like 12.50' });
      return;
    }
    const key = attempt.keyFor(`${tender}:${cents}`);
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.pay(order.id, tender, cents, key);
      attempt.settle();
      onUpdated(res.order);
      setAmount('');
      setFeedback({ kind: 'success', text: `${tender === 'card' ? 'Card charged' : 'Cash taken'}: ${fmt(cents)}` });
    } catch (err) {
      const fb = feedbackFor(err, fmt, () => submit());
      // Unknown outcome: keep the key so Retry resumes the same payment.
      if (!fb || fb.kind !== 'error' || !fb.retry) attempt.settle();
      setFeedback(fb);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Add a tender</h2>
      {done ? (
        <p className="muted">Nothing outstanding. Refunding a tender reopens the balance.</p>
      ) : (
        <form onSubmit={submit} className="tender-form">
          <div className="segmented" role="radiogroup" aria-label="Tender type">
            {(['card', 'cash'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={tender === t}
                className={tender === t ? 'active' : ''}
                onClick={() => setTender(t)}
              >
                {t === 'card' ? 'Card' : 'Cash'}
              </button>
            ))}
          </div>

          <label className="field">
            <span>Amount</span>
            <div className="input-money">
              <span aria-hidden="true">$</span>
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder={centsToInput(order.outstanding_cents)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button type="button" className="link" onClick={() => setAmount(centsToInput(order.outstanding_cents))}>
                Remaining
              </button>
            </div>
          </label>

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? (tender === 'card' ? 'Charging card…' : 'Recording…') : `Charge ${tender}`}
          </button>
        </form>
      )}
      <Feedback state={feedback} />
    </section>
  );
}
