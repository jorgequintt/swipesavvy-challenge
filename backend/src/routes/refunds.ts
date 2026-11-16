import { Router } from 'express';
import type pg from 'pg';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { parseCents } from '../money.js';
import { getOrderView, toRefundView } from '../orders.js';
import type { PaymentHooks } from '../payments.js';
import { applyRefund } from '../refunds.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mounted at /api/orders/:orderId/refunds.
export function refundsRouter(pool: pg.Pool, gateway: Gateway, hooks: PaymentHooks = {}) {
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
    if (typeof body.payment_id !== 'string' || !UUID.test(body.payment_id)) {
      throw badRequest('payment_id must be the id of a payment on this order', {
        field: 'payment_id',
      });
    }
    const amountCents = parseCents(body.amount_cents, 'amount_cents');

    const { refund, replayed } = await applyRefund(
      pool,
      gateway,
      { orderId, paymentId: body.payment_id, amountCents, idempotencyKey },
      hooks,
    );

    if (replayed) res.set('Idempotent-Replayed', 'true');

    if (refund.status === 'failed') {
      throw new ApiError(402, 'REFUND_DECLINED', 'The gateway declined the refund', {
        refund_id: refund.id,
        reason: refund.failure_reason,
      });
    }

    const order = await getOrderView(pool, orderId);
    res.status(replayed ? 200 : 201).json({ refund: toRefundView(refund), order });
  });

  return router;
}
