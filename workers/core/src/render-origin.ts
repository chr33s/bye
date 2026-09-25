// RenderOrigin (infra/resources/workers.ts `makeRenderOrigin`): the separate render host for
// workers.dev installations. It forwards every request unchanged to MailCore, which keys on the
// request host and serves only `/render/*` and `/img` here. No other bindings, no state.

interface RenderOriginEnv {
  readonly CORE: { fetch(request: Request): Promise<Response> };
}

export default {
  fetch: (request: Request, env: RenderOriginEnv): Promise<Response> => env.CORE.fetch(request),
};
