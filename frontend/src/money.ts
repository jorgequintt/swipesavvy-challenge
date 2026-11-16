// The UI is the only place dollars exist. Everything sent to or received from the
// API is integer cents.

// "19.99" -> 1999, parsed as text. Never `Number(x) * 100`: 19.99 * 100 is
// 1998.9999999999998 in floating point. Returns null for anything that isn't a
// positive amount with at most two decimals.
export function parseDollars(input: string): number | null {
  const match = /^\s*\$?\s*(\d{1,13})(?:\.(\d{0,2}))?\s*$/.exec(input);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

// 1999 -> "19.99" for prefilling an input.
export function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.NumberFormat>();

// 1999 -> "$19.99". Display only: built from the integer parts, so no float math.
export function formatCents(cents: number, currency = 'USD'): string {
  let nf = formatters.get(currency);
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    formatters.set(currency, nf);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  // Format the whole part with the currency symbol and grouping, then swap in the
  // exact cents: "$1,234.00" -> "$1,234.56".
  return sign + nf.format(whole).replace(/\.00$/, `.${frac}`);
}
