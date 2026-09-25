// The one raster-image sniffer (render origin, day photos, World media). Declared content types
// and file names are never trusted: only magic bytes decide, and only these raster types pass
// (never SVG or HTML).

export type RasterType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const sniffRaster = (b: Uint8Array): RasterType | null => {
  const at = (i: number, bytes: ReadonlyArray<number>) => bytes.every((v, j) => b[i + j] === v);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
};
