import { Composition } from "remotion";
import { FPS, ByeDemoReel, TOTAL_FRAMES } from "./ByeDemoReel";

export const RemotionRoot = () => (
  <Composition
    id="ByeDemoReel"
    component={ByeDemoReel}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={1280}
    height={720}
  />
);
