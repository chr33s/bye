import { Effect, Exit, Layer } from "effect";
import * as TestClockFx from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import {
  authenticateRequest,
  closeOwnAccount,
  reactivateTeamMember,
  removeTeamMember,
  setTeamMemberRole,
  createPublicThreadLink,
  issueApiToken,
  MailboxSelection,
  publishWorldPost,
  requestAuthLayer,
  SharedSpaces,
  shareThread,
  suspendTeamMember,
  WorldPublishing,
} from "@bye/application";
import {
  ControlAuth,
  ControlDeviceAuth,
  ControlDirectory,
  ControlBilling,
  ControlCommerce,
  ControlDomains,
  ControlLifecycle,
  ControlSharedRegistry,
  ControlSupport,
  controlServicesLayer,
  ControlOrganizations,
  makeLocalSharedSpaces,
  makeLocalWorldPublishing,
  SharedSpaceStore,
  SendingPolicy,
  WorldStore,
} from "@bye/platform-cloudflare";
import { MemoryD1, MemoryDurableStorage, TestClock } from "@bye/testing";

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();

  const auth = new ControlAuth(d1, clock, {
    rp: { rpId: "bye.test", origins: [], requireUserVerification: true },
    totpKeys: { current: 1, keys: { 1: new Uint8Array(32) } },
    recoveryPepper: "p",
  });

  const directory = new ControlDirectory(d1, clock);
  const orgs = new ControlOrganizations(d1, clock);
  const lifecycle = new ControlLifecycle(d1, clock, "s");
  const commerce = new ControlCommerce(d1, clock, null, "s");

  const control = controlServicesLayer({
    db: d1,
    auth,
    directory,
    orgs,
    lifecycle,
    commerce,
    billing: new ControlBilling(d1, clock, commerce),
    domains: new ControlDomains(d1, clock),
    sending: new SendingPolicy(d1, clock),
    support: new ControlSupport(d1, clock),
    registry: new ControlSharedRegistry(d1, clock),
    operators: [],
  });

  const alice = await directory.provisionPersonalAccount({
    address: "alice@bye.test",
    displayName: "Alice",
  });

  const space = new SharedSpaceStore(new MemoryDurableStorage(), clock);
  space.init({
    spaceId: "spc_1",
    kind: "team",
    organizationId: alice.organizationId,
    ownerId: alice.userId,
  });
  const world = new WorldStore(new MemoryDurableStorage(), clock, "u");
  world.init({
    authorId: alice.userId,
    handle: "alice",
    title: "Alice",
    addresses: ["alice@bye.test"],
  });
  const copied: Array<string> = [];

  const services = Layer.mergeAll(
    control,
    Layer.succeed(
      SharedSpaces,
      makeLocalSharedSpaces(() => space),
    ),
    Layer.succeed(
      WorldPublishing,
      makeLocalWorldPublishing(
        () => world,
        (_from, to) => void copied.push(to),
      ),
    ),
    Layer.succeed(MailboxSelection, {
      selectMessages: (_m, _t, refs) =>
        Effect.succeed({
          subject: "Quote",
          messages: refs.map((r, i) => ({
            messageRef: r,
            from: { address: "c@example.test" },
            to: [{ address: "alice@bye.test" }],
            cc: [],
            subject: "Quote",
            snippet: "s",
            contentKey: `k/${r}`,
            sentAt: i,
          })),
        }),
    }),
    TestClockFx.layer(),
  );

  /** Run an effect as a request authenticated with `token`. */
  const run = <A, E>(token: string, effect: Effect.Effect<A, E, any>, method = "POST") =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClockFx.setTime(clock.now());

        const authn = yield* authenticateRequest(
          { method, cookieToken: undefined, bearerToken: token, origin: null, secFetchSite: null },
          "https://app.bye.test",
        );

        return yield* effect.pipe(Effect.provide(requestAuthLayer(authn)));
      }).pipe(Effect.provide(services), Effect.exit) as Effect.Effect<Exit.Exit<A, E>>,
    );

  const failureTag = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit)
      ? (JSON.stringify(exit.cause).match(/"_tag":"(\w+)"/g) ?? [])
          .map((m) => m.slice(8, -1))
          .find((t) => t !== "Fail" && t !== "Cause")
      : "Success";

  return {
    d1,
    clock,
    auth,
    orgs,
    directory,
    alice,
    space,
    world,
    services,
    run,
    failureTag,
    copied,
  };
};

describe("control use cases", () => {
  it("[A03] cookie-authenticated cross-origin writes are rejected; bearer tokens are not ambient", async () => {
    const { auth, alice, services, clock } = await setup();
    const { token } = await auth.issueSession(alice.userId, "laptop");

    const attempt = (creds: Parameters<typeof authenticateRequest>[0]) =>
      Effect.runPromise(
        authenticateRequest(creds, "https://app.bye.test").pipe(
          Effect.provide(services),
          Effect.exit,
        ),
      );

    const cross = await attempt({
      method: "POST",
      cookieToken: token,
      bearerToken: undefined,
      origin: "https://evil.test",
      secFetchSite: "cross-site",
    });

    expect(Exit.isFailure(cross) && JSON.stringify(cross.cause)).toContain("Forbidden");

    const same = await attempt({
      method: "POST",
      cookieToken: token,
      bearerToken: undefined,
      origin: "https://app.bye.test",
      secFetchSite: null,
    });

    expect(Exit.isSuccess(same)).toBe(true);

    const none = await attempt({
      method: "GET",
      cookieToken: undefined,
      bearerToken: undefined,
      origin: null,
      secFetchSite: null,
    });

    expect(JSON.stringify(Exit.isFailure(none) && none.cause)).toContain("Unauthenticated");
    expect(clock.now()).toBeGreaterThan(0);
  });

  it("[X02] consequential agent scopes require step-up; agents cannot mint credentials", async () => {
    const { auth, alice, run, failureTag } = await setup();
    const plain = await auth.issueSession(alice.userId, "laptop");
    expect(
      failureTag(
        await run(
          plain.token,
          issueApiToken({ kind: "agent", label: "a", scopes: ["read", "send"] }),
        ),
      ),
    ).toBe("StepUpRequired");
    const created = await run(plain.token, issueApiToken({ kind: "agent", label: "a" }));

    if (!Exit.isSuccess(created)) throw new Error("expected token");
    expect(created.value.scopes).toEqual(["read", "draft"]);
    expect(
      failureTag(await run(created.value.token, issueApiToken({ kind: "agent", label: "b" }))),
    ).toBe("Forbidden");
    const stepped = await auth.issueSession(alice.userId, "laptop", true);
    expect(
      Exit.isSuccess(
        await run(
          stepped.token,
          issueApiToken({ kind: "cli", label: "c", scopes: ["read", "send"] }),
        ),
      ),
    ).toBe(true);
  });

  it("[X02] a device (desktop/mobile) session cannot mint API tokens that would outlive it", async () => {
    const { d1, clock, alice, run, failureTag } = await setup();
    const devices = new ControlDeviceAuth(d1, clock);

    const started = await devices.startDeviceAuthorization({
      clientId: "bye-cli",
      deviceName: "x",
    });

    expect(await devices.decideUserCode(alice.userId, started.user_code, true)).toBe(true);

    const tokens = await devices.pollDeviceCode({
      deviceCode: started.device_code,
      clientId: "bye-cli",
    });

    expect(tokens.access_token).toMatch(/^bda_/);
    expect(
      failureTag(await run(tokens.access_token, issueApiToken({ kind: "agent", label: "a" }))),
    ).toBe("Forbidden");
    expect(
      await d1
        .prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?")
        .bind(alice.userId)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("[O02] admin mutations need an admin scope, membership and a recent step-up", async () => {
    const { auth, orgs, directory, alice, run, failureTag, clock } = await setup();

    const bob = await directory.provisionPersonalAccount({
      address: "bob@bye.test",
      displayName: "Bob",
    });

    const orgId = await orgs.createOrganization(alice.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 5,
    });

    const inv = await orgs.invite(
      orgId,
      await orgs.verifiedActor(orgId, alice.userId),
      "bob@bye.test",
      "member",
    );

    await orgs.acceptInvitation(inv.token, bob.userId);
    const plain = await auth.issueSession(alice.userId, "x");
    expect(failureTag(await run(plain.token, suspendTeamMember(orgId, bob.userId)))).toBe(
      "StepUpRequired",
    );
    const stepped = await auth.issueSession(alice.userId, "x", true);
    expect(Exit.isSuccess(await run(stepped.token, suspendTeamMember(orgId, bob.userId)))).toBe(
      true,
    );
    clock.advance(11 * 60_000);
    expect(failureTag(await run(stepped.token, suspendTeamMember(orgId, bob.userId)))).toBe(
      "StepUpRequired",
    );
    const bobSession = await auth.issueSession(bob.userId, "x", true);
    expect(failureTag(await run(bobSession.token, suspendTeamMember(orgId, alice.userId)))).toBe(
      "Forbidden",
    );
  });

  it("[A04] account closure requires step-up and explicit address confirmation", async () => {
    const { auth, alice, run, failureTag, directory } = await setup();
    const stepped = await auth.issueSession(alice.userId, "x", true);
    expect(
      failureTag(
        await run(
          stepped.token,
          closeOwnAccount({
            confirmAddress: "wrong@bye.test",
            reserveAddressDays: 30,
            forwardingDays: 0,
          }),
        ),
      ),
    ).toBe("Conflict");

    const ok = await run(
      stepped.token,
      closeOwnAccount({
        confirmAddress: "Alice@bye.test",
        reserveAddressDays: 30,
        forwardingDays: 0,
      }),
    );

    expect(Exit.isSuccess(ok) && ok.value.reserved).toEqual(["alice@bye.test"]);
    expect(await directory.resolveRecipient("alice@bye.test")).toEqual({
      _tag: "Rejected",
      reason: "closed",
    });
    await expect(auth.authenticate(stepped.token)).rejects.toThrow();
  });

  it("[O02] an admin action reads the actor's role once (no re-check inside the adapter)", async () => {
    const { auth, orgs, directory, alice, run } = await setup();

    const bob = await directory.provisionPersonalAccount({
      address: "bob@bye.test",
      displayName: "Bob",
    });

    const orgId = await orgs.createOrganization(alice.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 5,
    });

    const inv = await orgs.invite(
      orgId,
      await orgs.verifiedActor(orgId, alice.userId),
      "bob@bye.test",
      "member",
    );

    await orgs.acceptInvitation(inv.token, bob.userId);
    const stepped = await auth.issueSession(alice.userId, "x", true);
    const reads: Array<string> = [];
    const original = orgs.membership.bind(orgs);
    orgs.membership = (org: string, userId: string) => (reads.push(userId), original(org, userId));

    for (const action of [
      suspendTeamMember(orgId, bob.userId),
      reactivateTeamMember(orgId, bob.userId),
      setTeamMemberRole(orgId, bob.userId, "admin"),
      removeTeamMember(orgId, bob.userId),
    ]) {
      reads.length = 0;
      expect(Exit.isSuccess(await run(stepped.token, action))).toBe(true);
      expect(reads.filter((u) => u === alice.userId)).toEqual([alice.userId]);
    }
  });

  it("[§7.2] a bad request through the gateway is a bad_request rejection (400), never a Conflict (409)", async () => {
    const { auth, alice, run, failureTag } = await setup();
    const stepped = await auth.issueSession(alice.userId, "laptop", true);

    const exit = await run(
      stepped.token,
      issueApiToken({ kind: "cli", label: "c", scopes: ["read", "bogus" as never] }),
    );

    expect(failureTag(exit)).toBe("Rejection");
    expect(JSON.stringify(Exit.isFailure(exit) ? exit.cause : null)).toContain(
      '"code":"bad_request"',
    );
  });
});

describe("shared use cases", () => {
  it("[O04] sharing needs mailbox access and step-up; [O05] public links carry an unguessable token", async () => {
    const { auth, alice, run, failureTag, space } = await setup();
    const plain = await auth.issueSession(alice.userId, "x");

    const req = {
      spaceId: "spc_1",
      sourceMailboxId: alice.mailboxId,
      sourceThreadId: "thr_1",
      messageRefs: ["m1", "m2"],
      grantees: [],
      includeFuture: true,
    };

    expect(failureTag(await run(plain.token, shareThread(req)))).toBe("StepUpRequired");
    expect(
      failureTag(await run(plain.token, shareThread({ ...req, sourceMailboxId: "mbx_other" }))),
    ).toBe("Forbidden");
    const stepped = await auth.issueSession(alice.userId, "x", true);
    const shared = await run(stepped.token, shareThread(req));

    if (!Exit.isSuccess(shared)) throw new Error(String(shared.cause));
    expect(space.readThread(alice.userId, shared.value).messages).toHaveLength(2);

    const link = await run(
      stepped.token,
      createPublicThreadLink(
        { spaceId: "spc_1", threadId: shared.value, includeFuture: false },
        "https://share.bye.test",
      ),
    );

    if (!Exit.isSuccess(link)) throw new Error("expected link");
    const token = link.value.url.split("/").at(-1)!;
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect((await space.resolvePublicLink(token)).messages).toHaveLength(2);
  });

  it("[P01] API publishing requires the publish scope and copies only selected media", async () => {
    const { auth, alice, run, failureTag, world, copied } = await setup();
    const plain = await auth.issueSession(alice.userId, "x");
    const agent = await auth.createApiToken(plain.session.user_id, { kind: "agent", label: "a" });

    const post = {
      fromAddress: "alice@bye.test",
      title: "Hi",
      html: "<p>x</p>",
      text: "x",
      media: [{ contentKey: "t/m/part/1", name: "a.png", contentType: "image/png" }],
      publish: true,
    };

    expect(failureTag(await run(agent.token, publishWorldPost(post)))).toBe("Forbidden");
    expect(Exit.isSuccess(await run(plain.token, publishWorldPost(post)))).toBe(true);
    expect(world.publicPost("hi")?.title).toBe("Hi");
    expect(copied).toEqual([
      expect.stringMatching(/^site\/[a-z0-9-]+\/media\/[a-z0-9-]+-r1-a\.png$/),
    ]);

    // A forged author address is refused by the World authority itself (a `forbidden` Rejection).
    const forged = await run(
      plain.token,
      publishWorldPost({ ...post, fromAddress: "ceo@evil.test" }),
    );

    expect(failureTag(forged)).toBe("Rejection");
    expect(JSON.stringify(Exit.isFailure(forged) ? forged.cause : null)).toContain(
      '"code":"forbidden"',
    );
  });
});
