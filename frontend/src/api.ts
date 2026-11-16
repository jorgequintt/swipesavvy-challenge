// Typed client for the backend. Shapes mirror the views in backend/src/orders.ts.

export type Tender = 'card' | 'cash';
export type OrderStatus = 'open' | 'partially_paid' | 'paid';

export interface Payment {
  id: string;
  tender: Tender;
  amount_cents: number;
  refunded_cents: number;
  refundable_cents: number;
  status: 'pending' | 'captured' | 'failed';
  gateway_ref: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface Refund {
  id: string;
  payment_id: string;
  amount_cents: number;
  status: 'pending' | 'succeeded' | 'failed';
  gateway_ref: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  currency: string;
  total_cents: number;
  paid_cents: number;
  pending_cents: number;
  outstanding_cents: number;
  status: OrderStatus;
  created_at: string;
  payments: Payment[];
  refunds: Refund[];
}

export type FailureMode = 'decline' | 'timeout' | 'lost-response';

// The fake gateway inside the serving app (only available when DEV_TOOLS=1).
export interface GatewayState {
  charges: number;
  refunds: number;
  queued: FailureMode[];
}

export interface Version {
  color: string;
  version: string;
}

// Error shape: { error: { code, message, details } }. status 0 = network failure.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Request failed (${res.status})`, e?.details ?? {});
  }
  return data as T;
}

export const api = {
  version: () => request<Version>('GET', '/api/version'),
  createOrder: (totalCents: number) => request<Order>('POST', '/api/orders', { total_cents: totalCents }),
  getOrder: (id: string) => request<Order>('GET', `/api/orders/${id}`),
  pay: (orderId: string, tender: Tender, amountCents: number, idempotencyKey: string) =>
    request<{ payment: Payment; order: Order }>(
      'POST',
      `/api/orders/${orderId}/payments`,
      { tender, amount_cents: amountCents },
      { 'Idempotency-Key': idempotencyKey },
    ),
  devGateway: () => request<GatewayState>('GET', '/api/dev/gateway'),
  devFailNext: (mode: FailureMode) => request<GatewayState>('POST', '/api/dev/gateway/fail-next', { mode }),
  refund: (orderId: string, paymentId: string, amountCents: number, idempotencyKey: string) =>
    request<{ refund: Refund; order: Order }>(
      'POST',
      `/api/orders/${orderId}/refunds`,
      { payment_id: paymentId, amount_cents: amountCents },
      { 'Idempotency-Key': idempotencyKey },
    ),
};
