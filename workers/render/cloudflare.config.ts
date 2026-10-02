import { defineConfig } from "cf/config";
import { projectConfig } from "../../infra/cf/config/workers.ts";

export default defineConfig(() => projectConfig("RenderOrigin"));
