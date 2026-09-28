"use client";

import type { ReactNode } from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export interface ChatToPreviewLayoutProps {
  chat?: ReactNode;
  preview?: ReactNode;
  startChatRatio?: number;
  endChatRatio?: number;
  speed?: number;
  className?: string;
}

export function ChatToPreviewLayout({
  chat,
  preview,
  startChatRatio = 0.5,
  endChatRatio = 0.25,
  speed = 1,
  className,
}: ChatToPreviewLayoutProps) {
  const frame = useCurrentFrame() * speed;
  const { durationInFrames } = useVideoConfig();
  const ease = Easing.bezier(0.16, 1, 0.3, 1);
  const morphStart = durationInFrames * 0.1;
  const morphEnd = durationInFrames * 0.7;
  const ratio = interpolate(frame, [morphStart, morphEnd], [startChatRatio, endChatRatio], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const previewOpacity = interpolate(frame, [morphStart, morphEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const previewX = interpolate(frame, [morphStart, morphEnd], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  return (
    <div className={className} style={{ position: "absolute", inset: 0, display: "flex", gap: 16 }}>
      <div
        style={{
          flexBasis: `${ratio * 100}%`,
          flexGrow: 0,
          flexShrink: 0,
          position: "relative",
          overflow: "hidden",
          borderRadius: 18,
          border: "1px solid var(--line)",
          background: "var(--panel)",
        }}
      >
        <div style={{ position: "absolute", inset: 0, minWidth: 520 }}>{chat}</div>
      </div>
      <div
        style={{
          flexBasis: `${(1 - ratio) * 100}%`,
          flexGrow: 0,
          flexShrink: 0,
          position: "relative",
          overflow: "hidden",
          borderRadius: 18,
          border: "1px solid var(--line)",
          background: "var(--paper)",
          opacity: previewOpacity,
          transform: `translateX(${previewX}px)`,
        }}
      >
        <div style={{ position: "absolute", inset: 0, minWidth: 720 }}>{preview}</div>
      </div>
    </div>
  );
}
