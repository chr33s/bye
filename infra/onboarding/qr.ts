// Minimal QR Code encoder for the native-app handoff (spec.md §15.11 step 5): byte mode, error
// correction level M, versions 1–10 (up to 213 bytes, ample for an instance URL). Follows ISO/IEC
// 18004; the payload is only the instance's HTTPS URL, so no dependency is warranted.

/** Per version (index = version): total codewords, EC codewords per block, blocks as [count, dataCodewords]. */
const M_BLOCKS: ReadonlyArray<readonly [number, number, ReadonlyArray<readonly [number, number]>]> =
  [
    [0, 0, []],
    [26, 10, [[1, 16]]],
    [44, 16, [[1, 28]]],
    [70, 26, [[1, 44]]],
    [100, 18, [[2, 32]]],
    [134, 24, [[2, 43]]],
    [172, 16, [[4, 27]]],
    [196, 18, [[4, 31]]],
    [
      242,
      22,
      [
        [2, 38],
        [2, 39],
      ],
    ],
    [
      292,
      22,
      [
        [3, 36],
        [2, 37],
      ],
    ],
    [
      346,
      26,
      [
        [4, 43],
        [1, 44],
      ],
    ],
  ];

const ALIGNMENT: ReadonlyArray<ReadonlyArray<number>> = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const dataCapacity = (version: number) =>
  M_BLOCKS[version]![2].reduce((n, [count, data]) => n + count * data, 0);

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const gfMul = (x: number, y: number): number => {
  let z = 0;

  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }

  return z & 0xff;
};

const rsDivisor = (degree: number): Array<number> => {
  const result = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;

  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root) ^ (j + 1 < degree ? result[j + 1]! : 0);
    }

    root = gfMul(root, 0x02);
  }

  return result;
};

const rsRemainder = (
  data: ReadonlyArray<number>,
  divisor: ReadonlyArray<number>,
): Array<number> => {
  const result = Array.from({ length: divisor.length }, () => 0);

  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMul(coef, factor)));
  }

  return result;
};

const encodeCodewords = (bytes: Uint8Array, version: number): Array<number> => {
  const bits: Array<number> = [];

  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);

  for (const b of bytes) put(b, 8);
  const capacityBits = dataCapacity(version) * 8;
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);

  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: Array<number> = [];

  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  // Split into blocks, append EC, interleave.
  const [, ecLen, groups] = M_BLOCKS[version]!;
  const divisor = rsDivisor(ecLen);
  const blocks: Array<{ data: Array<number>; ec: Array<number> }> = [];
  let k = 0;

  for (const [count, len] of groups)
    for (let i = 0; i < count; i++) {
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ data: d, ec: rsRemainder(d, divisor) });
    }

  const out: Array<number> = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));

  for (let i = 0; i < maxData; i++)
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);

  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]!);

  return out;
};

export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  /** modules[y][x], true = dark. */
  readonly modules: ReadonlyArray<ReadonlyArray<boolean>>;
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const build = (version: number, codewords: ReadonlyArray<number>, mask: number): QrMatrix => {
  const size = version * 4 + 17;

  const m: Array<Array<boolean>> = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );

  const fn: Array<Array<boolean>> = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );

  const set = (x: number, y: number, dark: boolean) => {
    m[y]![x] = dark;
    fn[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;

        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
  };

  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = ALIGNMENT[version]!;

  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0)
      )
        continue;

      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

  // Format bits: EC level M = 0b00.
  const formatData = (0b00 << 3) | mask;
  let rem = formatData;

  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((formatData << 10) | rem) ^ 0x5412;
  const bit = (v: number, i: number) => ((v >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6));
  set(8, 8, bit(format, 7));
  set(7, 8, bit(format, 8));

  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));

  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));

  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, true);

  if (version >= 7) {
    let r = version;

    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const v = (version << 12) | r;

    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(v, i));
      set(b, a, bit(v, i));
    }
  }

  // Data in the zigzag order, then the mask on non-function modules.
  let i = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;

    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;

        if (!fn[y]![x] && i < codewords.length * 8) {
          m[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
  }

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (!fn[y]![x] && MASKS[mask]!(x, y)) m[y]![x] = !m[y]![x];

  return { version, size, mask, modules: m };
};

/** ISO/IEC 18004 §7.8.3 penalty score; the lowest-scoring mask is used. */
export const penalty = (modules: ReadonlyArray<ReadonlyArray<boolean>>): number => {
  const size = modules.length;
  let score = 0;

  const line = (get: (i: number) => boolean) => {
    let run = 1;

    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }

    const pattern = [true, false, true, true, true, false, true];

    for (let i = 0; i + 7 <= size; i++) {
      if (!pattern.every((p, k) => get(i + k) === p)) continue;

      const light = (from: number, to: number) => {
        for (let k = from; k < to; k++) if (k >= 0 && k < size && get(k)) return false;

        return true;
      };

      if (light(i - 4, i) || light(i + 7, i + 11)) score += 40;
    }
  };

  for (let y = 0; y < size; y++) line((x) => modules[y]![x]!);

  for (let x = 0; x < size; x++) line((y) => modules[y]![x]!);

  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y]![x];

      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1])
        score += 3;
    }

  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;

  return score;
};

export const encodeQr = (text: string, options: { readonly mask?: number } = {}): QrMatrix => {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  const need = (v: number) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;

  while (version <= 10 && need(version) > dataCapacity(version) * 8) version++;

  if (version > 10) throw new Error("text is too long for the handoff QR code");
  const codewords = encodeCodewords(bytes, version);

  if (options.mask !== undefined) return build(version, codewords, options.mask);
  let best: QrMatrix | null = null;
  let bestScore = Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = build(version, codewords, mask);
    const score = penalty(candidate.modules);

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best!;
};

/** Scalable SVG with a 4-module quiet zone; dark modules drawn as one path. */
export const qrSvg = (text: string): string => {
  const { size, modules } = encodeQr(text);
  const q = 4;
  let d = "";
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + q} ${y + q}h1v1h-1z`;
    }),
  );
  const n = size + q * 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code for the instance address"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
};
