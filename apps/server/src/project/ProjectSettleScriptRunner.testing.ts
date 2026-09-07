import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectSettleScriptRunner } from "./ProjectSettleScriptRunner.ts";

/** Existing orchestration tests opt out of external project commands explicitly. */
export const noProjectSettleScripts = Layer.succeed(ProjectSettleScriptRunner, {
  prepare: () => Effect.succeed({ kind: "none" }),
  execute: () => Effect.die("Unexpected settle script execution"),
});
