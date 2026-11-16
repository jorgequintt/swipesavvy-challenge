import { useCallback } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import { History } from './History';
import { OrderSummary } from './OrderSummary';
import { TenderForm } from './TenderForm';
import { TenderList } from './TenderList';
import { TestTools } from './TestTools';

export function OrderPage({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const load = useCallback(() => api.getOrder(orderId), [orderId]);
  const { data: order, error, setData } = usePolling(load, 1000);

  if (!order) {
    return (
      <div className="page">
        <button type="button" className="link back" onClick={onBack}>
          ← New order
        </button>
        <p className="muted">{error ? (error.status === 404 ? 'Order not found.' : error.message) : 'Loading order…'}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <button type="button" className="link back" onClick={onBack}>
          ← New order
        </button>
        <span className="order-id" title={order.id}>
          Order {order.id.slice(0, 8)}
        </span>
        <span className={`live ${error ? 'live-off' : ''}`}>{error ? 'Reconnecting…' : 'Live'}</span>
      </div>

      <div className="order-grid">
        <div className="col">
          <OrderSummary order={order} />
          <TenderForm order={order} onUpdated={setData} />
        </div>
        <div className="col">
          <TenderList order={order} onUpdated={setData} />
          <History order={order} />
        </div>
      </div>

      <TestTools order={order} />
    </div>
  );
}
