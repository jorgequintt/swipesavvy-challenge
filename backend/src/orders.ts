import type pg from 'pg';
import { centsFromDb } from './money.js';
import { notFound } from './errors.js';

export type Db = pg.Pool | pg.PoolClient;
export type OrderStatus = 'open' | 'partially_paid' | 'paid';

export interface OrderRow {
  id: string;
  total_cents: string; // string because it's what pg returns for bigint
  paid_cents: string; // string because it's what pg returns for bigint
  currency: string;
  created_at: Date;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  tender: 'card' | 'cash';
  amount_cents: string; // string because it's what pg returns for bigint
  refunded_cents: string; // string because it's what pg returns for bigint
  status: 'pending' | 'captured' | 'failed';
  gateway_ref: string | null;
  failure_reason: string | null;
  created_at: Date;
  idempotency_key: string;
  request_hash: string;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  order_id: string;
  amount_cents: string; // string because it's what pg returns for bigint
  status: 'pending' | 'succeeded' | 'failed';
  idempotency_key: string;
  request_hash: string;
  gateway_ref: string | null;
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
    `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at, id`,
    [id],
  );

  const { rows: refunds } = await db.query<RefundRow>(
    `SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at, id`,
    [id],
  );

  const total = centsFromDb(order.total_cents);
  const paid = centsFromDb(order.paid_cents);
  const paymentViews = payments.map((p) => toPaymentView(p));
  const pending = paymentViews
    .filter((p) => p.status === 'pending')
    .reduce((sum, p) => sum + p.amount_cents, 0);

  return {
    id: order.id,
    currency: order.currency,
    total_cents: total,
    paid_cents: paid,
    pending_cents: pending,
    outstanding_cents: total - paid,
    status: orderStatus(total, paid, pending),
    created_at: order.created_at,
    payments: paymentViews,
    refunds: refunds.map((r) => toRefundView(r)),
  };
}

export async function lockOrder(
  client: pg.PoolClient,
  orderId: string,
): Promise<OrderRow> {
  const {
    rows: [order],
  } = await client.query<OrderRow>(
    'SELECT id, total_cents, paid_cents, currency, created_at FROM orders WHERE id = $1 FOR UPDATE',
    [orderId],
  );

  if (!order) throw notFound('Order');
  return order;
}

export type Orderview = NonNullable<Awaited<ReturnType<typeof getOrderView>>>;

function orderStatus(total: number, paid: number, pending: number): OrderStatus {
  if (paid === 0) return 'open';
  return paid === total && pending === 0 ? 'paid' : 'partially_paid';
}

export function toPaymentView(p: PaymentRow) {
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
    created_at: p.created_at,
  };
}

export type PaymentView = ReturnType<typeof toPaymentView>;

export function toRefundView(r: RefundRow) {
  return {
    id: r.id,
    payment_id: r.payment_id,
    amount_cents: centsFromDb(r.amount_cents),
    status: r.status,
    gateway_ref: r.gateway_ref,
    failure_reason: r.failure_reason,
    created_at: r.created_at,
  };
}

export type RefundView = ReturnType<typeof toRefundView>;