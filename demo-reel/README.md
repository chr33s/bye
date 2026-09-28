# Bye demo reel

A 1280×720, 30 fps product reel for Bye. Built with Remotion and copied
[remocn](https://github.com/Remocn/remocn) components (see `THIRD_PARTY_NOTICES.md`).
It is isolated from the pnpm workspace and installs with npm.

Storyboard (about 41 s, no voice-over, works muted):

1. Hero: "Say bye to what matters. Say hey to the rest."
2. Screener: approve an unknown sender, it lands in the Imbox (E01, E04)
3. Piles: Imbox, The Feed, The Paper Trail, Reply Later, Set Aside, Bubble Up
4. Outbound: frozen draft → undo window → MIME → submit → record; `unknown` is never retried blindly
5. Calendar: invitations from approved senders become events
6. Clients: `bye instance add` validation and platform matrix
7. Outro: open source, with the validation caveat

Claims follow `readme.md` and `spec.md`: locally validated in Node and workerd, not deployed
to Cloudflare or production. Keep new copy inside that boundary.

## Run

Requirements: Node 24+ and npm.

```sh
npm install
npm run studio   # Remotion Studio
npm run render   # out/bye-demo-reel.mp4
npm run optimize # re-encode for web: smaller, faststart (run after render)
npm run still    # out/bye-demo-reel-poster.png
```

The soundtrack (`public/bye-bed.wav`) is generated deterministically by `scripts/generate-audio.ts`.
Timing lives in `src/ByeDemoReel.tsx` (`SCENE_FRAMES`); keep the audio hit times in sync.

- Theme: `src/styles.css` and `src/brand.tsx`, following `bye.pdf` (Sunset #E5572D, Ink #1D1B16, Paper #F6F1E7, Pine #2F5D50; Fraunces ExtraBold for the wordmark and headlines, DM Sans for body)
- Scenes: `src/scenes.tsx`
