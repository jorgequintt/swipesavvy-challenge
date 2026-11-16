import { useState, type FormEvent } from 'react';
import { api, type Order, type Payment } from '../api';
import { useAttemptKey } from '../hooks';
import { centsToInput, formatCents, parseDollars } from '../money';
import { Feedback, feedbackFor, useFeedback } from './Feedback';

interface Props {
  order: Order;
  payment: Payment;
  onUpdated: (o: Order) => void;
  onClose: () => void;
}

export function RefundForm({ order, payment, onUpdated, onClose }: Props) {
  const [amount, setAmount] = useState(centsToInput(payment.refundable_cents));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useFeedback();
  const attempt = useAttemptKey();
  const fmt = (c: number) => formatCents(c, order.currency);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const cents = parseDollars(amount);
    if (cents === null) {
      setFeedback({ kind: 'error', text: 'Enter an amount like 12.50' });
      return;
    }
    const key = attempt.keyFor(`${payment.id}:${cents}`);
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.refund(order.id, payment.id, cents, key);
      attempt.settle();
      onUpdated(res.order);
      onClose();
    } catch (err) {
      const fb = feedbackFor(err, fmt, () => submit());
      if (!fb || fb.kind !== 'error' || !fb.retry) attempt.settle();
      setFeedback(fb);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="refund-form" onSubmit={submit}>
      <label className="field">
        <span>Refund amount (up to {fmt(payment.refundable_cents)})</span>
        <div className="input-money">
          <span aria-hidden="true">$</span>
          <input inputMode="decimal" autoComplete="off" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      </label>
      <div className="refund-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-danger" disabled={busy}>
          {busy ? 'Refunding…' : 'Refund'}
        </button>
      </div>
      <Feedback state={feedback} />
    </form>
  );
}
