import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { AbsoluteFill, Audio, staticFile } from "remotion";
import { focusPull } from "./components/remocn/focus-pull";
import {
  CalendarScene,
  ClientsScene,
  HeroScene,
  PilesScene,
  OutboundScene,
  OutroScene,
  ScreenerScene,
} from "./scenes";

export const FPS = 30;
export const TRANSITION_FRAMES = 30;
export const SCENE_FRAMES = [150, 250, 230, 210, 190, 190, 170] as const;
export const TOTAL_FRAMES =
  SCENE_FRAMES.reduce((total, duration) => total + duration, 0) -
  TRANSITION_FRAMES * (SCENE_FRAMES.length - 1);

const scenes = [
  HeroScene,
  ScreenerScene,
  PilesScene,
  OutboundScene,
  CalendarScene,
  ClientsScene,
  OutroScene,
] as const;

export const ByeDemoReel = () => (
  <AbsoluteFill className="canvas">
    <Audio src={staticFile("bye-bed.wav")} volume={1} />
    <TransitionSeries>
      {scenes.flatMap((Scene, index) => [
        ...(index > 0
          ? [
              <TransitionSeries.Transition
                key={`t${index}`}
                timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
                presentation={focusPull({ blur: 12 })}
              />,
            ]
          : []),
        <TransitionSeries.Sequence key={`s${index}`} durationInFrames={SCENE_FRAMES[index]}>
          <Scene />
        </TransitionSeries.Sequence>,
      ])}
    </TransitionSeries>
  </AbsoluteFill>
);
