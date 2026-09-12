/** The app mark, same geometry as assets/icon.svg. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id="ev-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset=".55" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="114" fill="url(#ev-logo-bg)" />
      <path d="M130 116a26 26 0 0 1 26-26h146l84 84v222a26 26 0 0 1-26 26H156a26 26 0 0 1-26-26z" fill="#fff" />
      <path d="M302 90l84 84h-64a20 20 0 0 1-20-20z" fill="#c7d2fe" />
      <g stroke="#6d28d9" strokeWidth="17" strokeLinecap="round" opacity=".9">
        <path d="M204 392L204 294" />
        <path d="M204 294L300 240" />
        <path d="M300 240L336 326" />
        <path d="M204 294L336 326" />
      </g>
      <g fill="#4c1d95">
        <circle cx="204" cy="294" r="35" />
        <circle cx="300" cy="240" r="26" />
        <circle cx="336" cy="326" r="23" />
        <circle cx="204" cy="392" r="21" />
      </g>
    </svg>
  );
}
