import { randomUUID } from "node:crypto";

export interface WriterLease {
  readonly leaseId?: string;
  /** Must throw before a write when ownership cannot be proven. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface WriterLocks {
  acquire(key: string, owner: string): Promise<WriterLease>;
}

export const writerKey = (accountId: string, stage: string, installation = "ci"): string => {
  if (
    !/^[a-f0-9]{32}$/.test(accountId) ||
    !/^[a-z0-9-]+$/.test(stage) ||
    !/^[a-z0-9-]+$/.test(installation)
  )
    throw new Error("invalid writer authority key");

  return `bye:cf:${accountId}:${stage}:${installation}`;
};

/** Shared authority must serialize cf and rollback writers for the same key. No local-file fallback. */
export const httpWriterLocks = (options: {
  readonly origin: string;
  readonly credential: string;
  readonly fetcher?: typeof fetch;
}): WriterLocks => {
  if (options.credential.length < 32)
    throw new Error("writer authority requires a private credential of at least 32 characters");
  const origin = new URL(options.origin);

  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("writer authority must be an HTTPS origin");

  const request = async (action: string, key: string, owner: string, leaseId: string) => {
    const response = await (options.fetcher ?? fetch)(new URL(`/cf-locks/${action}`, origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${options.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ key, owner, leaseId }),
    });

    if (!response.ok) throw new Error(`writer authority rejected ${action}`);
  };

  return {
    async acquire(key, owner) {
      const leaseId = randomUUID();
      await request("acquire", key, owner, leaseId);

      return {
        leaseId,
        assertHeld: () => request("assert", key, owner, leaseId),
        release: () => request("release", key, owner, leaseId),
      };
    },
  };
};
