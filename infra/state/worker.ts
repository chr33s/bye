// State Worker entry module. workerd only accepts handlers and classes as exports of the main
// module, so all logic, constants and helpers live in ./core.ts (tests import from there).
import { handleStateRequest, type StateEnv, StateStoreObject } from "./core.ts";

export { StateStoreObject };

export default {
  fetch: (request: Request, env: StateEnv) => handleStateRequest(request, env),
};
