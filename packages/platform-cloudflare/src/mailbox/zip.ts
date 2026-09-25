// Streaming ZIP writer for bulk attachment download (E20). Entries are stored (no compression) and
// streamed with data descriptors, so bytes are never buffered whole in the isolate. Callers bound
// the entry count and total size; this writer rejects anything that would need ZIP64.

export interface ZipEntrySource {
  readonly name: string;
  readonly modified: number;
  /** Opened lazily so only one object body is in flight at a time. */
  readonly open: () => Promise<ReadableStream<Uint8Array> | null>;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export const crc32Update = (crc: number, bytes: Uint8Array): number => {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const ZIP32_LIMIT = 0xffffffff;

const dosDateTime = (ms: number): { readonly time: number; readonly date: number } => {
  const d = new Date(ms);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
};

/** Remove path separators and control characters; keep names unique within the archive. */
export const safeZipName = (name: string, used: Set<string>): string => {
  const base =
    name
      // oxlint-disable-next-line no-control-regex -- intentional control-char match
      .replace(/[\u0000-\u001f\u007f/\\:]+/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 200) || "attachment";
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const dot = base.lastIndexOf(".");
    candidate = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
};

export const zipStream = (entries: ReadonlyArray<ZipEntrySource>): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  const central: Array<Uint8Array> = [];
  let offset = 0;
  let index = 0;
  let current: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    crc: number;
    size: number;
    name: Uint8Array;
    headerOffset: number;
    dos: { time: number; date: number };
  } | null = null;

  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (current) {
          const { done, value } = await current.reader.read();
          if (!done && value) {
            current.crc = crc32Update(current.crc, value);
            current.size += value.byteLength;
            offset += value.byteLength;
            if (offset > ZIP32_LIMIT) throw new Error("archive too large");
            controller.enqueue(value);
            return;
          }
          // Data descriptor, then central directory record for the finished entry.
          const descriptor = new Uint8Array([
            ...u32(0x08074b50),
            ...u32(current.crc),
            ...u32(current.size),
            ...u32(current.size),
          ]);
          controller.enqueue(descriptor);
          offset += descriptor.byteLength;
          central.push(
            new Uint8Array([
              ...u32(0x02014b50),
              ...u16(20),
              ...u16(20),
              ...u16(0x0808),
              ...u16(0),
              ...u16(current.dos.time),
              ...u16(current.dos.date),
              ...u32(current.crc),
              ...u32(current.size),
              ...u32(current.size),
              ...u16(current.name.byteLength),
              ...u16(0),
              ...u16(0),
              ...u16(0),
              ...u16(0),
              ...u32(0),
              ...u32(current.headerOffset),
              ...current.name,
            ]),
          );
          current = null;
          return;
        }
        if (index >= entries.length) {
          const dir = central.reduce((n, c) => n + c.byteLength, 0);
          for (const c of central) controller.enqueue(c);
          controller.enqueue(
            new Uint8Array([
              ...u32(0x06054b50),
              ...u16(0),
              ...u16(0),
              ...u16(central.length),
              ...u16(central.length),
              ...u32(dir),
              ...u32(offset),
              ...u16(0),
            ]),
          );
          controller.close();
          return;
        }
        const entry = entries[index++]!;
        const body = await entry.open();
        if (!body) continue;
        const name = enc.encode(entry.name);
        const dos = dosDateTime(entry.modified);
        // Flag 0x0808: sizes/CRC in the data descriptor, UTF-8 file names. Method 0 = stored.
        const header = new Uint8Array([
          ...u32(0x04034b50),
          ...u16(20),
          ...u16(0x0808),
          ...u16(0),
          ...u16(dos.time),
          ...u16(dos.date),
          ...u32(0),
          ...u32(0),
          ...u32(0),
          ...u16(name.byteLength),
          ...u16(0),
          ...name,
        ]);
        current = { reader: body.getReader(), crc: 0, size: 0, name, headerOffset: offset, dos };
        controller.enqueue(header);
        offset += header.byteLength;
        return;
      }
    },
    async cancel() {
      await current?.reader.cancel();
    },
  });
};
