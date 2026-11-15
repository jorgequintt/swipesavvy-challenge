import { randomUUID } from 'node:crypto';

export interface Gateway {
  charge(req: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
  }): Promise<{ ref: string }>;
}

export class GatewayDeclined extends Error {}

export class GatewayTimeout extends Error {}

type FailureMode = 'decline' | 'timeout' | 'lost-response';

export class FakeGateway implements Gateway {
  private charges = new Map<string, { ref: string; amountCents: number }>();
  private queuedFailures: FailureMode[] = [];

  constructor(public latencyMs = 0) {}

  failNext(...modes: FailureMode[]) {
    this.queuedFailures.push(...modes);
  }

  get chargeCount() {
    return this.charges.size;
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
}
