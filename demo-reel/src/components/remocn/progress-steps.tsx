"use client";

import { interpolate, interpolateColors, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface ProgressStepsProps {
  steps?: Array<{ label: string }>;
  activeColor?: string;
  inactiveColor?: string;
  textColor?: string;
  stepDuration?: number;
  speed?: number;
  className?: string;
}

export function ProgressSteps({
  steps = [{ label: "Connect" }, { label: "Process" }, { label: "Deploy" }],
  activeColor = "#22c55e",
  inactiveColor = "#27272a",
  textColor = "white",
  stepDuration = 30,
  speed = 1,
  className,
}: ProgressStepsProps) {
  const frame = useCurrentFrame() * speed;
  const { fps } = useVideoConfig();
  const trackLength = 920;
  const segmentLength = trackLength / Math.max(steps.length - 1, 1);
  const nodeRadius = 22;

  return (
    <div className={className} style={{ position: "absolute", inset: 0 }}>
      <div
        style={{
          position: "absolute",
          width: trackLength,
          height: 120,
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
        }}
      >
        <svg
          width={trackLength}
          height={4}
          style={{ position: "absolute", left: 0, top: nodeRadius - 2, overflow: "visible" }}
        >
          {steps.slice(0, -1).map((_, index) => (
            <line
              key={`background-${index}`}
              x1={index * segmentLength}
              y1={2}
              x2={(index + 1) * segmentLength}
              y2={2}
              stroke={inactiveColor}
              strokeWidth={4}
              strokeLinecap="round"
            />
          ))}
          {steps.slice(0, -1).map((_, index) => {
            const lineStart = index * stepDuration;
            const fillOffset = interpolate(
              frame,
              [lineStart, lineStart + stepDuration],
              [segmentLength, 0],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            );
            return (
              <line
                key={index}
                x1={index * segmentLength}
                y1={2}
                x2={(index + 1) * segmentLength}
                y2={2}
                stroke={activeColor}
                strokeWidth={4}
                strokeLinecap="round"
                strokeDasharray={segmentLength}
                strokeDashoffset={fillOffset}
              />
            );
          })}
        </svg>
        {steps.map((step, index) => {
          const activateAt = index * stepDuration;
          const localFrame = frame - activateAt;
          const pop = spring({
            frame: localFrame,
            fps,
            config: { damping: 10, stiffness: 180, mass: 0.6 },
          });
          const fill = interpolateColors(
            frame,
            [activateAt, activateAt + 8],
            [inactiveColor, activeColor],
          );
          const checkOpacity = interpolate(frame, [activateAt + 6, activateAt + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={step.label}
              style={{
                position: "absolute",
                left: index * segmentLength,
                top: 0,
                transform: "translateX(-50%)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 14,
              }}
            >
              <div
                style={{
                  width: nodeRadius * 2,
                  height: nodeRadius * 2,
                  borderRadius: 999,
                  background: fill,
                  border: `2px solid ${activeColor}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transform: `scale(${interpolate(pop, [0, 1], [0.8, 1])})`,
                  boxShadow: `0 0 0 6px ${activeColor}1a`,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" opacity={checkOpacity}>
                  <path
                    d="M5 12.5l4.5 4.5L19 7"
                    stroke="white"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <span
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: textColor,
                  whiteSpace: "nowrap",
                }}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
