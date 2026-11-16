import { Router } from 'express';
import { badRequest } from '../errors.js';
import { FAILURE_MODES, type FakeGateway, type FailureMode } from '../gateway.js';

// Test tools for demos and manual probing: inspect the fake gateway and make its
// next call fail. Only mounted when DEV_TOOLS=1. A real deployment must never
// expose a way to inject payment failures.
//
// The fake gateway lives inside each app process, so these act on whichever
// color is serving: the same one that will handle your next payment.
export function devRouter(gateway: FakeGateway) {
  const router = Router();

  const state = () => ({
    charges: gateway.chargeCount,
    refunds: gateway.refundCount,
    queued: gateway.queued,
  });

  router.get('/gateway', (req, res) => {
    res.set('Cache-Control', 'no-store').json(state());
  });

  // Body: { "mode": "decline" | "timeout" | "lost-response" }
  router.post('/gateway/fail-next', (req, res) => {
    const mode = req.body?.mode;
    if (!FAILURE_MODES.includes(mode)) {
      throw badRequest(`mode must be one of: ${FAILURE_MODES.join(', ')}`, { field: 'mode' });
    }
    gateway.failNext(mode as FailureMode);
    res.json(state());
  });

  return router;
}
