import type pg from 'pg';
import { centsFromDb } from './money.js';

export type Db = pg.Pool | pg.PoolClient;
export type OrderStatus = 'open' | 'partially_paid' | 'paid';

interface OrderRow {
  id: string;
  total_cents: string; // string because it's what pg returns for bigint
  paid_cents: string; // string because it's what pg returns for bigint
  currency: string;
  created_at: Date;
}

interface PaymentRow {
  id: string;
  tender: 'card' | 'cash';
  amount_cents: string; // string because it's what pg returns for bigint
  refunded_cents: string; // string because it's what pg returns for bigint
  status: 'pending' | 'captured' | 'failed';
  gateway_ref: string | null;
  failure_reason: string | null;
  created_at: Date;
}

interface RefundRow {
  id: string;
  payment_id: string;
  amount_cents: string; // string because it's what pg returns for bigint
  status: 'pending' | 'succeeded' | 'failed';
  failure_reason: string | null;
  created_at: Date;
}

export async function createOrder(
  db: Db,
  totalCents: number,
  currency: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO orders (total_cents, currency) VALUES ($1, $2) RETURNING id',
    [totalCents, currency],
  );

  return rows[0].id;
}

export async function getOrderView(db: Db, id: string) {
  const {
    rows: [order],
  } = await db.query<OrderRow>(
    'SELECT id, total_cents, paid_cents, currency, created_at FROM orders WHERE id = $1',
    [id],
  );

  if (!order) return null;

  const { rows: payments } = await db.query<PaymentRow>(
    `SELECT id, tender, amount_cents, refunded_cents, status, gateway_ref, failure_reason, created_at FROM payments WHERE order_id = $1 ORDER BY created_at, id`,
    [id],
  );

  const { rows: refunds } = await db.query<RefundRow>(
    `SELECT id, payment_id, amount_cents, status, failure_reason, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at, id`,
    [id],
  );

  const total = centsFromDb(order.total_cents);
  const paid = centsFromDb(order.paid_cents);

  return {
    id: order.id,
    currency: order.currency,
    total_cents: total,
    paid_cents: paid,
    outstanding_cents: total - paid,
    status: orderStatus(total, paid),
    created_at: order.created_at,
    payments: payments.map(p => {
      const amount = centsFromDb(p.amount_cents);
      const refunded = centsFromDb(p.refunded_cents);
      return {
        id: p.id,
        tender: p.tender,
        amount_cents: amount,
        refunded_cents: refunded,
        refundable_cents: p.status === 'captured' ? amount - refunded : 0,
        status: p.status,
        gateway_ref: p.gateway_ref,
        failure_reason: p.failure_reason,
        created_at: p.created_at
      }
    }),
    refunds: refunds.map(r => ({
      id: r.id,
      payment_id: r.payment_id,
      amount_cents: centsFromDb(r.amount_cents),
      status: r.status,
      failure_reason: r.failure_reason,
      created_at: r.created_at
    }))
  }
}

export type Orderview = NonNullable<Awaited<ReturnType<typeof getOrderView>>>;

function orderStatus(total: number, paid: number): OrderStatus {
  if (paid === 0) return 'open';
  return paid === total ? 'paid' : 'partially_paid';
}
