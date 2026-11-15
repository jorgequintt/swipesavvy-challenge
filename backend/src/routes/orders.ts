import { Router } from 'express';
import type pg from 'pg';
import { badRequest, notFound } from '../errors.js';
import { parseCents } from '../money.js';
import { createOrder, getOrderView } from '../orders.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ordersRouter(pool: pg.Pool) {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = req.body ?? {};
    const total = parseCents(body.total_cents, 'total_cents');
    const currency = body.currency ?? 'USD';
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw badRequest('currency must be a 3 letter ISO code', { field: 'currency' });
    }

    const id = await createOrder(pool, total, currency);
    const order = await getOrderView(pool, id);
    res.status(201).location(`/api/orders/${id}`).json(order);
  });

  router.get('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) throw notFound('Order');
    const order = await getOrderView(pool, req.params.id);
    if (!order) throw notFound('Order');
    res.json(order);
  });

  return router;
}
