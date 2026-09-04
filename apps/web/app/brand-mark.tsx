/**
 * The AchPay mark: a sealed record.
 *
 * A coin-sized ring — the payment — crossed by a chain of three links, which is
 * the hash chain the ledger is built on. It is one path plus three shapes so it
 * stays legible at 22px in the topbar, and it inherits `currentColor` so the
 * inverse footer gets it in cream without a second asset.
 */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9.25" />
      <path d="M5 12h3.4M15.6 12H19" />
      <rect x="8.4" y="9.1" width="7.2" height="5.8" rx="2.9" />
    </svg>
  );
}
