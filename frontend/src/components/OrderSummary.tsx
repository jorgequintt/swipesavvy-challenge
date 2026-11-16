import type { Order } from '../api';
import { formatCents } from '../money';
import { StatusPill } from './StatusPill';

export function OrderSummary({ order }: { order: Order }) {
  const fmt = (c: number) => formatCents(c, order.currency);
  const settled = order.paid_cents - order.pending_cents;
  const pct = (c: number) => `${(c / order.total_cents) * 100}%`;

  return (
    <section className="card summary" aria-label="Order totals">
      <div className="summary-head">
        <span className="label">Order total</span>
        <StatusPill status={order.status} />
      </div>
      <div className="summary-total money">{fmt(order.total_cents)}</div>

      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={order.total_cents}
        aria-valuenow={order.paid_cents}
        aria-label="Amount paid"
      >
        <div className="progress-settled" style={{ width: pct(settled) }} />
        <div className="progress-pending" style={{ width: pct(order.pending_cents) }} />
      </div>

      <dl className="summary-figures">
        <div>
          <dt>Paid so far</dt>
          <dd className="money">{fmt(order.paid_cents)}</dd>
          {order.pending_cents > 0 && <span className="hint">incl. {fmt(order.pending_cents)} pending</span>}
        </div>
        <div className="outstanding">
          <dt>Outstanding</dt>
          <dd className="money">{fmt(order.outstanding_cents)}</dd>
        </div>
      </dl>
    </section>
  );
}
