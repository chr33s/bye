import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_TRANSACTIONAL_CAPABILITIES } from "@bye/domain";
import {
  parseSandboxDomains,
  sandboxTransport,
  type TransportAdapter,
} from "@bye/platform-cloudflare";

const inner = (): TransportAdapter & { calls: number } => {
  const a = {
    calls: 0,
    capabilities: {
      ...CLOUDFLARE_TRANSACTIONAL_CAPABILITIES,
      trafficClasses: ["personal" as const],
    },
    submit: () => {
      a.calls++;

      return Effect.succeed({ providerId: "p-1" });
    },
  };

  return a;
};

const submission = (to: Array<string>) => ({
  sendJobId: "snd_1",
  identityId: "idn_1",
  from: "a@preview.bye.test",
  contentKey: "k",
  envelopeRecipients: to,
  trafficClass: "personal" as const,
  bytes: 100,
});

describe("[X01] preview mail sandbox (§15.8)", () => {
  it("delivers only to the preview's disposable domains and rejects everything else before the provider", async () => {
    const adapter = inner();

    const sandboxed = sandboxTransport(
      adapter,
      parseSandboxDomains("preview.bye.test, @sink.bye.test, not a domain"),
    );

    expect(
      Result.isSuccess(
        await Effect.runPromise(
          Effect.result(
            sandboxed.submit(submission(["x@sink.bye.test", "y@sub.preview.bye.test"])),
          ),
        ),
      ),
    ).toBe(true);

    const external = await Effect.runPromise(
      Effect.result(sandboxed.submit(submission(["x@sink.bye.test", "ceo@gmail.com"]))),
    );

    expect(Result.isFailure(external) && external.failure.kind).toBe("Rejected");

    const lookalike = await Effect.runPromise(
      Effect.result(sandboxed.submit(submission(["x@evilsink.bye.test.attacker.com"]))),
    );

    expect(Result.isFailure(lookalike)).toBe(true);
    expect(adapter.calls).toBe(1);
  });

  it("fails closed when no domains are configured", async () => {
    const adapter = inner();

    const r = await Effect.runPromise(
      Effect.result(sandboxTransport(adapter, []).submit(submission(["x@sink.bye.test"]))),
    );

    expect(Result.isFailure(r)).toBe(true);
    expect(adapter.calls).toBe(0);
  });
});
