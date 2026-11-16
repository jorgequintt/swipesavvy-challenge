import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { parseDollars } from '../money';
import { describeError } from './Feedback';

const RECENT_KEY = 'recent-orders';

export function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...loadRecent().filter((x) => x !== id)].slice(0, 5)));
  } catch {
    // storage unavailable (private mode): recent list is a convenience only
  }
}

export function NewOrder({ onOpen }: { onOpen: (id: string) => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = loadRecent();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(amount);
    if (cents === null) {
      setError('Enter a total like 42.50');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const order = await api.createOrder(cents);
      remember(order.id);
      onOpen(order.id);
    } catch (err) {
      setError(describeError(err, String));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <section className="card">
        <h2>New order</h2>
        <form onSubmit={submit} className="tender-form">
          <label className="field">
            <span>Order total</span>
            <div className="input-money input-large">
              <span aria-hidden="true">$</span>
              <input
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </label>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Creating…' : 'Create order'}
          </button>
          {error && (
            <div className="feedback feedback-error" role="alert">
              {error}
            </div>
          )}
        </form>
      </section>

      {recent.length > 0 && (
        <section className="card">
          <h2>Recent orders</h2>
          <ul className="recent">
            {recent.map((id) => (
              <li key={id}>
                <button type="button" className="link" onClick={() => onOpen(id)}>
                  Order {id.slice(0, 8)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
