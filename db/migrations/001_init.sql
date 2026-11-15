CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  paid_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_no_overpay CHECK (paid_cents BETWEEN 0 AND total_cents)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  tender text NOT NULL CHECK (tender IN ('card', 'cash')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  refunded_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'captured', 'failed')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  gateway_ref text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payments_no_over_refund CHECK (refunded_cents BETWEEN 0 AND amount_cents),
  CONSTRAINT payments_refund_only_captured CHECK (status = 'captured' OR refunded_cents = 0),
  CONSTRAINT payments_card_has_ref CHECK (status <> 'captured' OR tender = 'cash' OR gateway_ref IS NOT NULL),
  CONSTRAINT payments_idempotency UNIQUE (order_id, idempotency_key),
  CONSTRAINT payments_id_order UNIQUE (id, order_id)
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status in ('pending', 'succeeded', 'failed')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  gateway_ref text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refunds_payment_fk FOREIGN KEY (payment_id, order_id) REFERENCES payments (id, order_id),
  CONSTRAINT refunds_idempotency UNIQUE (order_id, idempotency_key)
);

CREATE INDEX refunds_payment_id_idx ON refunds (payment_id);