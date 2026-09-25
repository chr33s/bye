// Minimal typing for the a11y test. @types/jsdom is deliberately not installed: vitest's optional
// types re-export it, which would pull the DOM lib into every Node/Workers program and break
// Uint8Array/BufferSource typing repo-wide.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis & { eval(code: string): unknown };
  }
}
