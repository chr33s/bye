"use client";

import type {
  TransitionPresentation,
  TransitionPresentationComponentProps,
} from "@remotion/transitions";
import type React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";

export type FocusPullProps = { blur?: number };

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const FocusPullPresentation: React.FC<TransitionPresentationComponentProps<FocusPullProps>> = ({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}) => {
  const { blur = 16 } = passedProps;
  const progress = presentationProgress;

  if (presentationDirection === "exiting") {
    return (
      <AbsoluteFill
        style={{
          opacity: interpolate(progress, [0.42, 0.68], [1, 0], {
            ...clamp,
            easing: Easing.bezier(0.42, 0, 0.58, 1),
          }),
          transform: `scale(${interpolate(progress, [0, 0.6], [1, 1.05], clamp)})`,
          filter: `blur(${interpolate(progress, [0.05, 0.55], [0, blur], clamp)}px) brightness(${interpolate(progress, [0.1, 0.55], [1, 1.3], clamp)})`,
        }}
      >
        {children}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        opacity: interpolate(progress, [0.32, 0.52], [0, 1], clamp),
        transform: `scale(${interpolate(progress, [0.35, 1], [0.97, 1], clamp)})`,
        filter: `blur(${interpolate(progress, [0.35, 0.9], [blur, 0], clamp)}px) brightness(${interpolate(progress, [0.4, 0.85], [1.25, 1], clamp)})`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export function focusPull(props: FocusPullProps = {}): TransitionPresentation<FocusPullProps> {
  return { component: FocusPullPresentation, props };
}
