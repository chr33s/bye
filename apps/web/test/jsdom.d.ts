// Minimal typing for the a11y test. @types/jsdom is deliberately not installed: vitest's optional
// types re-export it, which would pull the DOM lib into every Node/Workers program and break
// Uint8Array/BufferSource typing repo-wide.
declare module "jsdom" {
  export interface JSDOMOptions {
    readonly url?: string;
    readonly runScripts?: "dangerously" | "outside-only";
    readonly pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis & { eval(code: string): void };
  }
}
