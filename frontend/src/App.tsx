import { useCallback, useEffect, useState } from 'react';
import { ColorBadge } from './components/ColorBadge';
import { NewOrder } from './components/NewOrder';
import { OrderPage } from './components/OrderPage';

// Two screens, so routing is just the URL path: "/" or "/orders/<id>". Using real
// paths means a refresh (or a link) reopens the same order.
function orderIdFromPath(): string | null {
  return /^\/orders\/([0-9a-f-]{36})\/?$/i.exec(window.location.pathname)?.[1] ?? null;
}

export function App() {
  const [orderId, setOrderId] = useState(orderIdFromPath);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const onPop = () => setOrderId(orderIdFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (id: string | null) => {
    window.history.pushState(null, '', id ? `/orders/${id}` : '/');
    setOrderId(id);
  };

  const onColorChange = useCallback((color: string, version: string) => {
    setToast(`Now served by ${color.toUpperCase()} (${version})`);
    setTimeout(() => setToast(null), 4000);
  }, []);

  return (
    <>
      <header className="topbar">
        <button type="button" className="brand" onClick={() => go(null)}>
          Split-Tender Ledger
        </button>
        <ColorBadge onChange={onColorChange} />
      </header>
      <main>{orderId ? <OrderPage key={orderId} orderId={orderId} onBack={() => go(null)} /> : <NewOrder onOpen={go} />}</main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
