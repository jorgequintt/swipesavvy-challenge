const LABELS: Record<string, string> = {
  open: 'Open',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  pending: 'Pending',
  captured: 'Captured',
  succeeded: 'Refunded',
  failed: 'Failed',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status}`}>{LABELS[status] ?? status}</span>;
}
