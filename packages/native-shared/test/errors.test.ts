import { afterEach, describe, expect, it } from "vitest";
import { type ErrorReport, reportError, setErrorReporter, toErrorReport } from "../src/errors.ts";

describe("client error reports", () => {
  afterEach(() => setErrorReporter(null));

  it("keeps engine messages but drops application error text", () => {
    const engine = toErrorReport(new TypeError("x is not a function"), "error", 1);
    expect(engine).toMatchObject({ name: "TypeError", message: "x is not a function", at: 1 });

    const app = toErrorReport(
      new Error("Subject: quarterly numbers for bob@example.net"),
      "boundary",
    );

    expect(app.name).toBe("Error");
    expect(app).not.toHaveProperty("message");
    expect(JSON.stringify(app)).not.toContain("bob@example.net");
  });

  it("reduces stack frames to locations without queries or fragments", () => {
    const error = new Error("secret");
    error.stack = [
      "Error: secret",
      "    at render (https://app.bye.test/app.abc.js?q=hello:1:200)",
      "    at https://app.bye.test/#/search?q=bob:2:10",
      "render@https://app.bye.test/app.abc.js:1:200",
      "not a frame with secret text",
    ].join("\n");
    const report = toErrorReport(error, "error");
    expect(report.frames).toEqual([
      "render https://app.bye.test/app.abc.js:1:200",
      "<anonymous> https://app.bye.test/:2:10",
      "render https://app.bye.test/app.abc.js:1:200",
    ]);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("is a no-op by default and never throws from a reporter", () => {
    expect(() => reportError(new Error("x"), "error")).not.toThrow();
    const seen: Array<ErrorReport> = [];
    setErrorReporter((r) => seen.push(r), { platform: "web", release: "abc" });
    reportError("a string rejection", "unhandledrejection");
    expect(seen[0]).toMatchObject({
      source: "unhandledrejection",
      name: "string",
      platform: "web",
    });
    setErrorReporter(() => {
      throw new Error("reporter down");
    });
    expect(() => reportError(new Error("x"), "error")).not.toThrow();
  });
});
