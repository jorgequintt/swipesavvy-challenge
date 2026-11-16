import { useState } from 'react';
import type { Order } from '../api';
import { formatCents } from '../money';
import { RefundForm } from './RefundForm';
import { StatusPill } from './StatusPill';

export function TenderList({ order, onUpdated }: { order: Order; onUpdated: (o: Order) => void }) {
  const [refunding, setRefunding] = useState<string | null>(null);
  const fmt = (c: number) => formatCents(c, order.currency);

  return (
    <section className="card">
      <h2>Tenders</h2>
      {order.payments.length === 0 ? (
        <p className="muted">No tenders yet.</p>
      ) : (
        <ul className="tenders">
          {order.payments.map((p) => (
            <li key={p.id} className="tender">
              <div className="tender-row">
                <span className={`tender-icon tender-${p.tender}`} aria-hidden="true">
                  {p.tender === 'card' ? '▭' : '¤'}
                </span>
                <div className="tender-main">
                  <span className="tender-name">{p.tender === 'card' ? 'Card' : 'Cash'}</span>
                  <span className="hint">
                    {p.refunded_cents > 0 ? `${fmt(p.refunded_cents)} refunded` : p.failure_reason ?? (p.gateway_ref ? `ref ${p.gateway_ref.slice(3, 11)}` : '')}
                  </span>
                </div>
                <span className={`money tender-amount ${p.status === 'failed' ? 'struck' : ''}`}>{fmt(p.amount_cents)}</span>
                <StatusPill status={p.status} />
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={p.refundable_cents === 0 || refunding === p.id}
                  onClick={() => setRefunding(p.id)}
                  aria-label={`Refund ${p.tender} payment of ${fmt(p.amount_cents)}`}
                >
                  Refund
                </button>
              </div>
              {refunding === p.id && (
                <RefundForm order={order} payment={p} onUpdated={onUpdated} onClose={() => setRefunding(null)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
