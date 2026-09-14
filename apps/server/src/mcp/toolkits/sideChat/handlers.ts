import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { SideChatReportError, SideChatToolkit } from "./tools.ts";

export const reportToParent = Effect.fn("SideChat.reportToParent")(function* (input: {
  readonly message: string;
}) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("side-chat")) {
    return yield* new SideChatReportError({
      message: "Reporting is only available in a side chat.",
    });
  }
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const transferId = CommandId.make(
    `side-chat-report:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
  );
  yield* engine
    .dispatch({
      type: "thread.context.report",
      commandId: transferId,
      threadId: invocation.threadId,
      message: input.message,
      createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    })
    .pipe(Effect.mapError((error) => new SideChatReportError({ message: error.message })));
  return { transferId, status: "queued" as const, delivery: "parent-next-turn" as const };
});

export const SideChatToolkitHandlersLive = SideChatToolkit.toLayer({
  report_to_parent: reportToParent,
});
