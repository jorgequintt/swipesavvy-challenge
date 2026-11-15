import { Router } from 'express';
import type pg from 'pg';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { parseCents } from '../money.js';
import { getOrderView, toPaymentView } from '../orders.js';
import { applyPayment, type PaymentHooks } from '../payments.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function paymentsRouter(
  pool: pg.Pool,
  gateway: Gateway,
  hooks: PaymentHooks = {},
) {
  const router = Router({ mergeParams: true });

  router.post('/', async (req, res) => {
    const { orderId } = req.params as { orderId: string };
    if (!UUID.test(orderId)) throw notFound('Order');

    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw badRequest('Idempotency-Key header is required (max 255 chars)', {
        field: 'Idempotency-Key',
      });
    }

    const body = req.body ?? {};
    if (body.tender !== 'card' && body.tender !== 'cash') {
      throw badRequest('tender must be "card" or "cash"', { field: 'tender' });
    }

    const amountCents = parseCents(body.amount_cents, 'amount_cents');

    const { payment, replayed } = await applyPayment(
      pool,
      gateway,
      {
        orderId,
        tender: body.tender,
        amountCents,
        idempotencyKey,
      },
      hooks,
    );

    if (replayed) res.set('Idempotent-Replayed', 'true');

    if (payment.status === 'failed') {
      throw new ApiError(402, 'CARD_DECLINED', 'The card was declined', {
        payment_id: payment.id,
        reason: payment.failure_reason,
      });
    }

    const order = await getOrderView(pool, orderId);
    res.status(replayed ? 200 : 201).json({ payment: toPaymentView(payment), order });
  });

  return router;
}
