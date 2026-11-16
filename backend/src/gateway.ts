import { randomUUID } from 'node:crypto';

export interface Gateway {
  charge(req: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
  }): Promise<{ ref: string }>;

  refund(req: {
    idempotencyKey: string;
    chargeRef: string;
    amountCents: number;
    currency: string;
  }): Promise<{ ref: string }>;
}

export class GatewayDeclined extends Error {}

export class GatewayTimeout extends Error {}

export const FAILURE_MODES = ['decline', 'timeout', 'lost-response'] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export class FakeGateway implements Gateway {
  private charges = new Map<string, { ref: string; amountCents: number }>();
  private refunds = new Map<
    string,
    { ref: string; chargeRef: string; amountCents: number }
  >();
  private queuedFailures: FailureMode[] = [];

  constructor(public latencyMs = 0) {}

  failNext(...modes: FailureMode[]) {
    this.queuedFailures.push(...modes);
  }

  get chargeCount() {
    return this.charges.size;
  }

  get refundCount() {
    return this.refunds.size;
  }

  // Failures waiting for the next gateway calls, in order.
  get queued(): readonly FailureMode[] {
    return [...this.queuedFailures];
  }

  async charge({
    idempotencyKey,
    amountCents,
  }: {
    idempotencyKey: string;
    amountCents: number;
  }) {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));

    const existing = this.charges.get(idempotencyKey);
    if (existing) return { ref: existing.ref };

    const failure = this.queuedFailures.shift();
    if (failure === 'decline') throw new GatewayDeclined('card_declined');
    if (failure === 'timeout') throw new GatewayTimeout('gateway did not answer');

    const ref = `ch_${randomUUID()}`;
    this.charges.set(idempotencyKey, { ref, amountCents });
    if (failure === 'lost-response') throw new GatewayTimeout('gateway did not answer');

    return { ref };
  }

  async refund({
    idempotencyKey,
    chargeRef,
    amountCents,
  }: {
    idempotencyKey: string;
    chargeRef: string;
    amountCents: number;
  }) {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));

    const existing = this.refunds.get(idempotencyKey);
    if (existing) return { ref: existing.ref };

    const failure = this.queuedFailures.shift();
    if (failure === 'decline') throw new GatewayDeclined('refund_declined');
    if (failure === 'timeout') throw new GatewayTimeout('gateway did not answer');

    const ref = `re_${randomUUID()}`;
    this.refunds.set(idempotencyKey, { ref, chargeRef, amountCents });

    if (failure === 'lost-response') throw new GatewayTimeout('gateway did not answer');

    return { ref };
  }
}
