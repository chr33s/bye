import { STATE_CONTRACT_VERSION } from "./core.ts";
import { stateBuildHash } from "./build-hash.ts";

// CI gate: the deployed state backend must speak the pinned contract and run exactly the reviewed
// source (§15.7). Usage: BYE_STATE_URL=… node --experimental-strip-types infra/state/verify-worker.ts

export type Fetcher = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface VerifyResult {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<string>;
}

export const verifyStateWorker = async (
  baseUrl: string,
  fetcher: Fetcher = fetch,
  expectedBuild = stateBuildHash(),
): Promise<VerifyResult> => {
  const problems: Array<string> = [];
  let body: { version?: unknown; build?: unknown } = {};
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/version`);
    if (response.status !== 200) problems.push(`/version returned ${response.status}`);
    else body = (await response.json()) as typeof body;
  } catch (error) {
    problems.push(
      `state backend unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (problems.length === 0) {
    if (body.version !== STATE_CONTRACT_VERSION)
      problems.push(`contract ${String(body.version)} != pinned ${STATE_CONTRACT_VERSION}`);
    if (body.build !== expectedBuild)
      problems.push(
        `deployed state Worker build ${String(body.build)} != reviewed source ${expectedBuild}`,
      );
  }
  return { ok: problems.length === 0, problems };
};

if (import.meta.main) {
  const url = process.env.BYE_STATE_URL ?? "";
  if (!url) {
    console.error("verify-worker: BYE_STATE_URL is required");
    process.exit(2);
  }
  const result = await verifyStateWorker(url);
  for (const p of result.problems) console.error(`verify-worker: ${p}`);
  if (result.ok)
    console.log("verify-worker: state backend contract and build match the reviewed source");
  process.exit(result.ok ? 0 : 1);
}
