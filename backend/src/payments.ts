import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from './db.js';
import { ApiError, unprocessable } from './errors.js';
import { GatewayDeclined, GatewayTimeout, type Gateway } from './gateway.js';
import { centsFromDb } from './money.js';
import { lockOrder, type PaymentRow } from './orders.js';

export interface PaymentRequest {
  orderId: string;
  tender: 'card' | 'cash';
  amountCents: number;
  idempotencyKey: string;
}

export interface PaymentHooks {
  afterBalanceCheck?: () => Promise<void>;
}

export interface PaymentResult {
  payment: PaymentRow;
  currency: string;
  replayed: boolean;
}

function requestHash(req: PaymentRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([req.tender, req.amountCents]))
    .digest('hex');
}

export async function applyPayment(
  pool: pg.Pool,
  gateway: Gateway,
  req: PaymentRequest,
  hooks: PaymentHooks = {},
): Promise<PaymentResult> {
  const hash = requestHash(req);

  const reserved = await withTransaction(pool, async (client) => {
    const order = await lockOrder(client, req.orderId);

    const {
      rows: [existingPayment],
    } = await client.query<PaymentRow>(
      'SELECT * FROM payments WHERE order_id = $1 AND idempotency_key = $2',
      [req.orderId, req.idempotencyKey],
    );

    if (existingPayment) {
      if (existingPayment.request_hash !== hash) {
        throw unprocessable(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency Key was already used for a different payment',
        );
      }

      return { payment: existingPayment, currency: order.currency, replayed: true };
    }

    const total = centsFromDb(order.total_cents);
    const paid = centsFromDb(order.paid_cents);
    const outstanding = total - paid;

    if (req.amountCents > outstanding) {
      throw unprocessable('OVERPAY', 'Payment exceeds outstanding amount', {
        amount_cents: req.amountCents,
        outstanding_cents: outstanding,
      });
    }

    await hooks.afterBalanceCheck?.();

    await client.query('UPDATE orders SET paid_cents = paid_cents + $2 WHERE id = $1', [
      order.id,
      req.amountCents,
    ]);

    const {
      rows: [payment],
    } = await client.query<PaymentRow>(
      `INSERT INTO payments (order_id, tender, amount_cents, status, idempotency_key, request_hash)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.orderId,
        req.tender,
        req.amountCents,
        req.tender === 'card' ? 'pending' : 'captured',
        req.idempotencyKey,
        hash,
      ],
    );

    return { payment, currency: order.currency, replayed: false };
  });

  if (reserved.payment.status !== 'pending') return reserved;

  const cardPayment = await settleWithGateway(
    pool,
    gateway,
    reserved.payment,
    reserved.currency,
  );
  return { ...reserved, payment: cardPayment };
}

async function settleWithGateway(
  pool: pg.Pool,
  gateway: Gateway,
  payment: PaymentRow,
  currency: string,
): Promise<PaymentRow> {
  try {
    const { ref } = await gateway.charge({
      idempotencyKey: `payment:${payment.id}`,
      amountCents: centsFromDb(payment.amount_cents),
      currency,
    });
    return await finalize(pool, payment, { status: 'captured', gatewayRef: ref });
  } catch (error) {
    if (error instanceof GatewayDeclined) {
      return await finalize(pool, payment, { status: 'failed', reason: error.message });
    }
    if (error instanceof GatewayTimeout) {
      throw new ApiError(
        504,
        'GATEWAY_TIMEOUT',
        'The card gateway did not answer. Retry with the same Idempotency-Key.',
        {
          payment_id: payment.id,
        },
      );
    }

    throw error;
  }
}

type Outcome =
  | { status: 'captured'; gatewayRef: string }
  | { status: 'failed'; reason: string };

async function finalize(
  pool: pg.Pool,
  payment: PaymentRow,
  outcome: Outcome,
): Promise<PaymentRow> {
  return withTransaction(pool, async (client) => {
    await lockOrder(client, payment.order_id);

    const {
      rows: [updated],
    } = await client.query<PaymentRow>(
      `UPDATE payments SET status = $2, gateway_ref = $3, failure_reason = $4, updated_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
      [
        payment.id,
        outcome.status,
        outcome.status === 'captured' ? outcome.gatewayRef : null,
        outcome.status === 'failed' ? outcome.reason : null,
      ],
    );

    if (updated && updated.status === 'failed') {
      await client.query('UPDATE orders SET paid_cents = paid_cents - $2 WHERE id = $1', [
        payment.order_id,
        centsFromDb(updated.amount_cents),
      ]);
    }

    if (updated) return updated;

    // If we reach here, someone else finished it. Return what they wrote
    const {
      rows: [current],
    } = await client.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [
      payment.id,
    ]);

    return current;
  });
}
