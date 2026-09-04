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
    <svg width="24" height="24" viewBox="0 0 476 483" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M256.508 273.919C254.07 273.314 251.575 273 249.037 273C221.147 273 198.537 310.832 198.537 357.5C198.537 359.055 198.563 360.601 198.612 362.136C152.502 387.52 127.037 410 127.037 410C71.0486 432.466 23.1033 464.93 23 465L57.5244 395C84.5371 366 127.037 343.5 127.037 343.5C127.037 343.5 91.0368 353.5 71.8271 366L159.57 188.099L210.037 161.5L256.508 273.919Z" fill="#FBC6B5"/>
      <path d="M306.037 149C292.037 167 238.537 196.5 238.537 196.5C238.537 196.5 295.077 178.5 314.037 165.5L462.074 465C461.938 464.868 398.691 403.722 295.801 389.453C298.209 379.596 299.537 368.807 299.537 357.5C299.537 324.104 287.958 295.234 271.151 281.514L213.537 149L165.537 176L242.537 18L306.037 149ZM199.12 370.387C199.761 377.393 200.916 384.115 202.519 390.443C179.109 394.049 157.091 399.849 137.037 406.662C137.118 406.602 159.909 389.883 199.12 370.387Z" fill="#A84F31"/>
    </svg>
  );
}
