import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import { isRetryable } from '../hooks';

export type FeedbackState =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string; retry?: () => void }
  | null;

// Feedback state for a form. Success messages clear themselves after a few
// seconds; errors stay until the next attempt, because they need action.
export function useFeedback() {
  const [state, setState] = useState<FeedbackState>(null);
  useEffect(() => {
    if (state?.kind !== 'success') return;
    const timer = setTimeout(() => setState(null), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  return [state, setState] as const;
}

// Turn an API error into something a cashier can act on.
export function describeError(e: unknown, fmt: (c: number) => string): string {
  if (!(e instanceof ApiError)) return 'Something went wrong.';
  const d = e.details;
  switch (e.code) {
    case 'OVERPAY':
      return `That's more than the ${fmt(Number(d.outstanding_cents))} outstanding.`;
    case 'OVER_REFUND':
      return `Only ${fmt(Number(d.refundable_cents))} can still be refunded on this tender.`;
    case 'CARD_DECLINED':
      return 'Card declined. Nothing was charged; try another card or cash.';
    case 'REFUND_DECLINED':
      return 'The gateway declined the refund. Nothing was refunded.';
    case 'PAYMENT_NOT_REFUNDABLE':
      return 'Only captured tenders can be refunded.';
    case 'GATEWAY_TIMEOUT':
      return "The card gateway didn't answer, so this is on hold. Retrying is safe: it can't charge twice.";
    case 'NETWORK':
      return "Couldn't reach the server. Retrying is safe: it can't charge twice.";
    case 'BUSY':
      return 'This order is busy with another request. Try again.';
    default:
      return e.message;
  }
}

export function feedbackFor(e: unknown, fmt: (c: number) => string, retry: () => void): FeedbackState {
  return { kind: 'error', text: describeError(e, fmt), retry: isRetryable(e) ? retry : undefined };
}

export function Feedback({ state }: { state: FeedbackState }) {
  if (!state) return null;
  return (
    <div className={`feedback feedback-${state.kind}`} role={state.kind === 'error' ? 'alert' : 'status'}>
      <span>{state.text}</span>
      {state.kind === 'error' && state.retry && (
        <button type="button" className="btn btn-small" onClick={state.retry}>
          Retry
        </button>
      )}
    </div>
  );
}
