import { useEffect, useRef } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';

// Shows which stack (blue or green) answered the most recent request. Polls every
// second, so during a cutover it flips within a second of the proxy switching.
export function ColorBadge({ onChange }: { onChange: (color: string, version: string) => void }) {
  const { data, error } = usePolling(api.version, 1000);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!data) return;
    if (last.current && last.current !== data.color) onChange(data.color, data.version);
    last.current = data.color;
  }, [data, onChange]);

  if (!data) return <span className="badge badge-unknown">{error ? 'offline' : '…'}</span>;
  return (
    <span key={data.color} className={`badge badge-${data.color} ${error ? 'badge-stale' : ''}`} title="Stack serving this app">
      <span className="badge-dot" aria-hidden="true" />
      {data.color.toUpperCase()} · {data.version}
    </span>
  );
}
