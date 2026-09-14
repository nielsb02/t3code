import { CommandId, ThreadReportMessage } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class SideChatReportError extends Schema.TaggedErrorClass<SideChatReportError>()(
  "SideChatReportError",
  { message: Schema.String },
) {}

export const ReportToParentTool = Tool.make("report_to_parent", {
  description:
    "Send a focused report to this side chat's parent when the user asks you to report back or your assignment includes reporting. Write the exact message the parent should receive: findings, changes, questions, or suggested next steps. The report is queued for the parent's next turn; it does not start or interrupt a turn. The user can inspect and cancel it before delivery. This sends only your message, not your conversation or compaction. Available only in a side chat.",
  parameters: Schema.Struct({ message: ThreadReportMessage }),
  success: Schema.Struct({
    transferId: CommandId,
    status: Schema.Literal("queued"),
    delivery: Schema.Literal("parent-next-turn"),
  }),
  failure: SideChatReportError,
  dependencies: [McpInvocationContext, OrchestrationEngineService, Crypto.Crypto],
})
  .annotate(Tool.Title, "Report to parent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const SideChatToolkit = Toolkit.make(ReportToParentTool);
