/**
 * Display helpers.
 *
 * Money arrives as integer paise and is divided by 100 exactly once, here, on
 * the way to a string. Nothing on this side of the wire adds, compares or
 * accumulates a rupee figure — the only arithmetic on money in the whole app is
 * the division on the next line.
 */

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return rupees.format(paise / 100);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} ${formatTime(iso)}`;
}

/** "in 4h", "expired 20m ago" — the only thing anyone reads off an expiry. */
export function relativeTo(iso: string, now = Date.now()): string {
  const delta = new Date(iso).getTime() - now;
  const past = delta < 0;
  const mins = Math.round(Math.abs(delta) / 60_000);
  const text =
    mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return past ? `${text} ago` : `in ${text}`;
}
