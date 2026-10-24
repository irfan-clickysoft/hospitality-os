import { useId } from 'react';

/**
 * The Stay360 logo, drawn as vectors so it stays sharp at any size and follows day or night mode: the roof, the window and the word "Stay" take the text colour,
 * the waves and "360" keep the brand blue. `LogoMark` is the roof, window and waves alone (for small places); `Logo` adds the name and the tagline.
 */
function Gradient({ id }: { id: string }) {
  return <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#19c4ff" /><stop offset="1" stopColor="#1769e0" /></linearGradient></defs>;
}
function Mark({ g }: { g: string }) {
  return (
    <g>
      <path d="M8 124 L186 10 L304 84 L274 92 L186 44 L56 124 Z" fill="currentColor" />
      <g fill="currentColor"><rect x="170" y="86" width="21" height="21" rx="2" /><rect x="196" y="86" width="21" height="21" rx="2" /><rect x="170" y="112" width="21" height="21" rx="2" /><rect x="196" y="112" width="21" height="21" rx="2" /></g>
      <path d="M6 150 C 58 122, 128 138, 190 156 C 228 166, 262 160, 296 138 C 270 178, 222 192, 170 180 C 112 168, 60 150, 6 164 Z" fill={`url(#${g})`} />
      <path d="M6 176 C 56 152, 120 168, 178 190 C 214 200, 250 196, 280 180 C 258 216, 212 222, 164 210 C 110 198, 58 182, 6 192 Z" fill={`url(#${g})`} opacity=".85" />
    </g>
  );
}

export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  const g = useId();
  return (
    <svg width={size * 1.62} height={size} viewBox="0 0 310 226" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false" className="logo-mark">
      <Gradient id={g} /><Mark g={g} />
    </svg>
  );
}

export function Logo({ height = 56, tagline = true, title = 'Stay360' }: { height?: number; tagline?: boolean; title?: string }) {
  const g = useId();
  return (
    <svg height={height} viewBox="0 0 1040 280" role="img" aria-label={`${title}${tagline ? ' — Hospitality. Simplified.' : ''}`} className="logo-full" style={{ width: 'auto', maxWidth: '100%' }}>
      <Gradient id={g} />
      <g transform="translate(0 6) scale(.93)"><Mark g={g} /></g>
      <text x="300" y="178" fontSize="168" fontWeight="800" fill="currentColor" letterSpacing="-6" style={{ fontFamily: '"Inter Variable", Inter, system-ui, sans-serif' }}>Stay</text>
      <text x="654" y="178" fontSize="168" fontWeight="800" fill={`url(#${g})`} letterSpacing="-6" style={{ fontFamily: '"Inter Variable", Inter, system-ui, sans-serif' }}>360</text>
      <circle cx="1002" cy="62" r="13" fill="none" stroke={`url(#${g})`} strokeWidth="9" />
      {tagline && <text x="304" y="250" fontSize="34" fontWeight="500" fill="currentColor" letterSpacing="9" opacity=".82" style={{ fontFamily: '"Inter Variable", Inter, system-ui, sans-serif' }}>HOSPITALITY. SIMPLIFIED.</text>}
    </svg>
  );
}
