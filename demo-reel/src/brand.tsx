import type React from "react";

export const colors = {
  sunset: "#E5572D",
  ink: "#1D1B16",
  paper: "#F6F1E7",
  pine: "#2F5D50",
} as const;

export const ByeIcon = ({
  size = 34,
  style,
  tile,
}: {
  size?: number;
  style?: React.CSSProperties;
  /** Render the mark white on a sunset tile (the app-icon variant). */
  tile?: boolean;
}) => (
  <svg aria-hidden="true" height={size} style={style} viewBox="0 0 64 64" width={size}>
    {tile ? <rect width="64" height="64" rx="16" fill={colors.sunset} /> : null}
    <rect x="6" y="16" width="46" height="38" rx="11" fill={tile ? "#FFFEF9" : colors.sunset} />
    <path
      d="M15 28 L29 39 L42 29"
      fill="none"
      stroke={tile ? colors.sunset : "#FFFEF9"}
      strokeWidth="4.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="50" cy="15" r="11" fill={colors.ink} />
    <rect x="48.4" y="6.5" width="3.4" height="9" rx="1.7" fill="#FFFEF9" />
    <rect x="45" y="13.5" width="10.4" height="6.5" rx="3" fill="#FFFEF9" />
  </svg>
);

export const Wordmark = ({ size, color }: { size: number; color?: string }) => (
  <span className="wordmark" style={{ fontSize: size, color }}>
    bye<span style={{ color: colors.sunset }}>.</span>
  </span>
);

export const ByeLogo = ({
  className,
  iconSize = 34,
  style,
}: {
  className?: string;
  iconSize?: number;
  style?: React.CSSProperties;
}) => (
  <span className={className} style={style}>
    <ByeIcon size={iconSize} />
    <Wordmark size={iconSize * 1.05} />
  </span>
);
