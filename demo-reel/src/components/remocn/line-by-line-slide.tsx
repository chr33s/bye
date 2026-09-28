"use client";

import type React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export interface LineByLineSlideProps {
  text: string;
  distance?: number;
  fontSize?: number;
  color?: string;
  fontWeight?: number;
  speed?: number;
  className?: string;
  renderLine?: (line: string) => React.ReactNode;
}

export function LineByLineSlide({
  text,
  distance = 48,
  fontSize = 72,
  color = "#171717",
  fontWeight = 600,
  speed = 1,
  className,
  renderLine,
}: LineByLineSlideProps) {
  const frame = useCurrentFrame() * speed;
  const { durationInFrames } = useVideoConfig();
  const lines = text.split("\n");
  const enterDur = 27;
  const enterTravel = 14;
  const exitDur = 18;
  const exitTravelFrom = 8;
  const enterStagger = 4;
  const exitStagger = 2;
  const enterEasing = Easing.bezier(0.22, 1, 0.36, 1);
  const exitEasing = Easing.bezier(0.64, 0, 0.78, 0);
  const enterEnd = enterDur + (lines.length - 1) * enterStagger;
  const exitStart = Math.max(
    enterEnd,
    durationInFrames - exitDur - (lines.length - 1) * exitStagger,
  );

  return (
    <div className="remocn-fill-center">
      <span
        className={className}
        style={{
          fontSize,
          fontWeight,
          color,
          letterSpacing: "-0.03em",
          lineHeight: 1.05,
          textAlign: "left",
          fontFamily: "var(--font-display)",
        }}
      >
        {lines.map((line, index) => {
          const enterLocal = frame - index * enterStagger;
          const exitLocal = frame - exitStart - index * exitStagger;
          const enterProgress = interpolate(enterLocal, [0, enterDur], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: enterEasing,
          });
          const exitProgress = interpolate(exitLocal, [0, exitDur], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: exitEasing,
          });
          const xEnter = interpolate(enterLocal, [0, enterTravel], [-distance, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: enterEasing,
          });
          const xExit = interpolate(exitLocal, [exitTravelFrom, exitDur], [0, distance], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: exitEasing,
          });

          return (
            <span
              key={line}
              style={{
                display: "block",
                transformOrigin: "0% 50%",
                opacity: enterProgress * (1 - exitProgress),
                transform: `translateX(${xEnter + xExit}px)`,
              }}
            >
              {renderLine ? renderLine(line) : line}
            </span>
          );
        })}
      </span>
    </div>
  );
}
