import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sampleRate = 48_000;
const channels = 2;
const seconds = 42;
const frames = sampleRate * seconds;
const outputGain = 1.58;
const bytesPerSample = 2;
const dataBytes = frames * channels * bytesPerSample;
const wav = Buffer.allocUnsafe(44 + dataBytes);

const writeAscii = (offset: number, value: string) => wav.write(value, offset, "ascii");
writeAscii(0, "RIFF");
wav.writeUInt32LE(36 + dataBytes, 4);
writeAscii(8, "WAVE");
writeAscii(12, "fmt ");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(channels, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
wav.writeUInt16LE(channels * bytesPerSample, 32);
wav.writeUInt16LE(bytesPerSample * 8, 34);
writeAscii(36, "data");
wav.writeUInt32LE(dataBytes, 40);

const chords = [
  [110, 164.81, 220],
  [98, 146.83, 196],
  [82.41, 123.47, 164.81],
  [92.5, 138.59, 185],
];
const sectionHits = [0, 4.0, 11.7, 19.0, 25.7, 32.4, 36.7];
const approvalClicks = [7.6];
let noiseState = 0x5eeda11;

const noise = (): number => {
  noiseState = (noiseState * 1_664_525 + 1_013_904_223) >>> 0;
  return noiseState / 0xffffffff - 0.5;
};

const smoothstep = (x: number): number => {
  const value = Math.max(0, Math.min(1, x));
  return value * value * (3 - 2 * value);
};

const pulse = (time: number, at: number, duration: number): number => {
  const local = time - at;
  if (local < 0 || local > duration) return 0;
  return Math.exp(-local * 7) * Math.sin(2 * Math.PI * (82 - local * 18) * local);
};

for (let i = 0; i < frames; i += 1) {
  const time = i / sampleRate;
  const chordIndex = Math.floor(time / 4) % chords.length;
  const chord = chords[chordIndex];
  const localChordTime = time % 4;
  const envelope =
    0.34 +
    0.66 * Math.min(smoothstep(localChordTime / 0.8), smoothstep((4 - localChordTime) / 0.8));

  let pad = 0;
  for (let note = 0; note < chord.length; note += 1) {
    const frequency = chord[note];
    pad +=
      Math.sin(2 * Math.PI * frequency * time + note * 0.6) * 0.45 +
      Math.sin(2 * Math.PI * frequency * 2.002 * time + note) * 0.08;
  }
  pad *= envelope / chord.length;

  const air = noise() * 0.025 * (0.7 + Math.sin(2 * Math.PI * 0.08 * time) * 0.3);
  const tick = Math.exp(-(time % 0.5) * 24) * Math.sin(2 * Math.PI * 880 * (time % 0.5)) * 0.045;
  const hit = sectionHits.reduce((sum, at) => sum + pulse(time, at, 0.8) * 0.18, 0);
  const click = approvalClicks.reduce((sum, at) => sum + pulse(time, at, 0.18) * 0.12, 0);
  const fadeIn = smoothstep(time / 1.2);
  const fadeOut = smoothstep((seconds - time) / 2.2);
  const master = fadeIn * fadeOut;

  const left =
    (pad * 0.24 + air + tick + hit + click + Math.sin(2 * Math.PI * 0.11 * time) * 0.01) *
    master *
    outputGain;
  const right =
    (pad * 0.24 +
      air * 0.8 +
      tick * 0.75 +
      hit +
      click -
      Math.sin(2 * Math.PI * 0.11 * time) * 0.01) *
    master *
    outputGain;

  const samples = [left, right];
  for (let channel = 0; channel < channels; channel += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[channel]));
    wav.writeInt16LE(Math.round(clamped * 32767), 44 + (i * channels + channel) * 2);
  }
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const output = resolve(scriptDirectory, "../public/bye-bed.wav");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, wav);
console.log(`Generated ${output}`);
