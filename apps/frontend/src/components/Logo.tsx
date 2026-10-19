export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="veylora-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6098fa" />
          <stop offset="1" stopColor="#1d45d8" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#veylora-mark)" />
      <path d="M8.5 9.5 16 23l7.5-13.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="23" r="2.2" fill="#fff" />
      <circle cx="8.5" cy="9.5" r="1.6" fill="#dbe8fe" />
      <circle cx="23.5" cy="9.5" r="1.6" fill="#dbe8fe" />
    </svg>
  );
}
