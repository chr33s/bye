// Local `alchemy dev` ports. Every Worker defaults to dev port 1337 with a fallback to the next
// free port, so the Workers race for 1337 and land on different ports each run, while APP_ORIGIN
// (and the instance document's baseUrl/issuer derived from it) names a fixed origin. Pin each
// Worker and fail rather than drift. Only set under `alchemy dev`, so deployed props are unchanged.
export const DEV_PORTS = {
  MailCore: 1337,
  PublicSite: 1338,
  SigMirror: 1339,
  RenderOrigin: 1340,
} as const;

const isDev = ["true", "1", "yes", "on"].includes((process.env["ALCHEMY_DEV"] ?? "").toLowerCase());

export const devServer = (worker: keyof typeof DEV_PORTS) =>
  isDev ? { dev: { port: DEV_PORTS[worker], strictPort: true } } : {};
