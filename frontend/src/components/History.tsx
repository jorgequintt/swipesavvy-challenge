import type { Order } from '../api';
import { formatCents } from '../money';
import { StatusPill } from './StatusPill';

interface Event {
  id: string;
  at: string;
  kind: 'payment' | 'refund';
  text: string;
  amount: number;
  status: string;
}

export function History({ order }: { order: Order }) {
  const fmt = (c: number) => formatCents(c, order.currency);
  const tenderOf = new Map(order.payments.map((p) => [p.id, p.tender]));

  const events: Event[] = [
    { id: 'created', at: order.created_at, kind: 'payment' as const, text: 'Order opened', amount: order.total_cents, status: '' },
    ...order.payments.map((p) => ({
      id: p.id,
      at: p.created_at,
      kind: 'payment' as const,
      text: `${p.tender === 'card' ? 'Card' : 'Cash'} payment`,
      amount: p.amount_cents,
      status: p.status,
    })),
    ...order.refunds.map((r) => ({
      id: r.id,
      at: r.created_at,
      kind: 'refund' as const,
      text: `Refund to ${tenderOf.get(r.payment_id) ?? 'tender'}`,
      amount: -r.amount_cents,
      status: r.status,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className="card">
      <h2>History</h2>
      <ol className="history">
        {events.map((e) => (
          <li key={e.id} className={`history-item history-${e.kind}`}>
            <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time>
            <span className="history-text">{e.text}</span>
            <span className="money">{fmt(e.amount)}</span>
            <span className="history-status">{e.status && <StatusPill status={e.status} />}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
