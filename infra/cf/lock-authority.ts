// Shared, non-expiring leases. A crashed owner remains locked until operator reconciliation.
// This stores writer ownership only; it is not a resource/deployment state database.
import { Schema } from "effect";

const Request = Schema.Struct({
  key: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  leaseId: Schema.NonEmptyString,
});

type LockRequest = Schema.Schema.Type<typeof Request>;

const Recovery = Schema.Struct({
  key: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  leaseId: Schema.NonEmptyString,
  reconciliationDigest: Schema.NonEmptyString,
  ticket: Schema.NonEmptyString,
  approvedBy: Schema.NonEmptyString,
});

interface AuthorityEnv {
  readonly WRITER_LOCKS: DurableObjectNamespace;
  readonly LOCK_CREDENTIAL: string;
  readonly LOCK_ADMIN_CREDENTIAL: string;
}

export class WriterLock {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: globalThis.Request): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").pop();

    if (action === "inspect" || action === "recover") {
      try {
        const input = Schema.decodeUnknownSync(Recovery)(await request.json(), {
          onExcessProperty: "error",
        });

        if (!/^[a-f0-9]{64}$/.test(input.reconciliationDigest))
          return new Response(null, { status: 400 });

        return await this.state.storage.transaction(async (storage) => {
          const held = await storage.get<LockRequest>("owner");

          if (action === "inspect") return Response.json({ held: held ?? null });

          if (
            !held ||
            held.key !== input.key ||
            held.owner !== input.owner ||
            held.leaseId !== input.leaseId
          )
            return new Response(null, { status: 409 });
          await storage.put("lastRecovery", { ...input, at: new Date().toISOString() });
          await storage.delete("owner");

          return new Response(null, { status: 200 });
        });
      } catch {
        return new Response(null, { status: 400 });
      }
    }

    let input: LockRequest;

    try {
      input = Schema.decodeUnknownSync(Request)(await request.json(), {
        onExcessProperty: "error",
      });
    } catch {
      return new Response("invalid request", { status: 400 });
    }

    if (
      !/^bye:cf:[a-f0-9]{32}:(prod|staging|preview-[1-9][0-9]{0,6}|dev-[a-z0-9]{6,16}):[a-z0-9-]+$/.test(
        input.key,
      )
    )
      return new Response("invalid key", { status: 400 });

    const result = await this.state.storage.transaction(async (storage) => {
      const held = await storage.get<LockRequest>("owner");

      const same =
        held?.key === input.key && held.owner === input.owner && held.leaseId === input.leaseId;

      if (action === "acquire") {
        if (held && !same) return 409;
        await storage.put("owner", input);

        return 200;
      }

      if (action === "assert") return same ? 200 : 409;

      if (action === "release") {
        if (held && !same) return 409;
        await storage.delete("owner");

        return 200;
      }

      return 404;
    });

    return new Response(null, { status: result });
  }
}

const authorized = async (provided: string, expected: string): Promise<boolean> => {
  const encoder = new TextEncoder();
  const left = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(provided)));

  const right = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${expected}`)),
  );

  let difference = 0;

  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;

  return difference === 0 && expected.length >= 32;
};

export default {
  async fetch(request: globalThis.Request, env: AuthorityEnv): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (
      request.method !== "POST" ||
      ![
        "/cf-locks/acquire",
        "/cf-locks/assert",
        "/cf-locks/release",
        "/cf-locks/inspect",
        "/cf-locks/recover",
      ].includes(path)
    )
      return new Response(null, { status: 404 });

    const administration = ["/cf-locks/inspect", "/cf-locks/recover"].includes(path);

    if (
      !(await authorized(
        request.headers.get("authorization") ?? "",
        (administration ? env.LOCK_ADMIN_CREDENTIAL : env.LOCK_CREDENTIAL) ?? "",
      ))
    )
      return new Response(null, { status: 401 });
    let input: LockRequest;

    try {
      input = Schema.decodeUnknownSync(administration ? Recovery : Request)(
        await request.clone().json(),
        {
          onExcessProperty: "error",
        },
      );
    } catch {
      return new Response(null, { status: 400 });
    }

    const id = env.WRITER_LOCKS.idFromName(input.key);

    return env.WRITER_LOCKS.get(id).fetch(request);
  },
} satisfies ExportedHandler<AuthorityEnv>;
