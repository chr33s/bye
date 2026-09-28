"use client";

import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface CursorPoint {
  x: number;
  y: number;
  hold?: number;
  click?: boolean;
}

export interface SimulatedCursorProps {
  points: CursorPoint[];
  color?: string;
  size?: number;
  speed?: number;
  className?: string;
}

export function SimulatedCursor({
  points,
  color = "#ffffff",
  size = 32,
  speed = 1,
  className,
}: SimulatedCursorProps) {
  const frame = useCurrentFrame() * speed;
  const { fps } = useVideoConfig();
  const travelPerLeg = 24;
  const segments: Array<{
    start: number;
    end: number;
    holdEnd: number;
    from: CursorPoint;
    to: CursorPoint;
  }> = [];
  let cursorFrame = points[0]?.hold ?? 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const start = cursorFrame;
    const end = start + travelPerLeg;
    const holdEnd = end + (to.hold ?? 15);
    segments.push({ start, end, holdEnd, from, to });
    cursorFrame = holdEnd;
  }

  let x = points[0]?.x ?? 0;
  let y = points[0]?.y ?? 0;
  let clickFrame: number | null = null;

  for (const segment of segments) {
    if (frame >= segment.start && frame < segment.holdEnd) {
      if (frame < segment.end) {
        x = interpolate(frame, [segment.start, segment.end], [segment.from.x, segment.to.x], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        y = interpolate(frame, [segment.start, segment.end], [segment.from.y, segment.to.y], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
      } else {
        x = segment.to.x;
        y = segment.to.y;
        if (segment.to.click) clickFrame = frame - segment.end;
      }
      break;
    }
    if (frame >= segment.holdEnd) {
      x = segment.to.x;
      y = segment.to.y;
    }
  }

  const clickSpring =
    clickFrame === null
      ? 0
      : spring({
          fps,
          frame: clickFrame,
          config: { damping: 10, stiffness: 200, mass: 0.6 },
          durationInFrames: 14,
        });
  const rippleRadius =
    clickFrame === null
      ? 0
      : interpolate(clickFrame, [0, 24], [4, 60], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const rippleOpacity =
    clickFrame === null
      ? 0
      : interpolate(clickFrame, [0, 24], [0.6, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

  return (
    <div className={className} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {rippleOpacity > 0 ? (
        <svg style={{ position: "absolute", left: x - 80, top: y - 80, width: 160, height: 160 }}>
          <circle
            cx={80}
            cy={80}
            r={rippleRadius}
            fill="none"
            stroke={color}
            strokeWidth={2}
            opacity={rippleOpacity}
          />
        </svg>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: size,
          height: size,
          transform: `scale(${1 - clickSpring * 0.18})`,
          transformOrigin: "top left",
          zIndex: 20,
        }}
      >
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path
            d="M5 3L5 19L9.5 14.5L12.5 21L15 20L12 13.5L18.5 13.5L5 3Z"
            fill={color}
            stroke="#000000"
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
