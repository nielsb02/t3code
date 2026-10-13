import type { OrchestrationV2AppThread, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "./ProjectionStore.ts";

const TITLE_MAX_CHARS = 80;
// A leading `/name` token, so a pasted path such as `/Users/me` is not one.
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(?:\s|$)/;

interface SideChatOrigin {
  readonly parentThreadId: ThreadId;
  readonly sourceRunId: RunId;
}

type SideChatNoteReads = Pick<ProjectionStore.ProjectionStoreV2Shape, "getThreadRecords">;
type SideChatThread = Pick<OrchestrationV2AppThread, "id" | "lineage" | "forkedFrom" | "sideChat">;

function sideChatOrigin(thread: SideChatThread): SideChatOrigin | null {
  if (
    thread.sideChat !== true ||
    thread.lineage.relationshipToParent !== "fork" ||
    thread.forkedFrom?.type !== "run"
  ) {
    return null;
  }
  return { parentThreadId: thread.forkedFrom.threadId, sourceRunId: thread.forkedFrom.runId };
}

/** Slash commands must stay at the start of the prompt. */
export function startsWithSlashCommand(text: string): boolean {
  return SLASH_COMMAND.test(text.trimStart());
}

/** Titles are user or model text; quote them on one bounded line. */
function quotedTitle(title: string): string {
  const compact = title.replaceAll(/\s+/g, " ").trim();
  return JSON.stringify(
    compact.length > TITLE_MAX_CHARS ? `${compact.slice(0, TITLE_MAX_CHARS - 3)}...` : compact,
  );
}

/**
 * Sent on a side chat's first turn in each native conversation. The side chat
 * reads the main thread on demand and reports back only when it matters; the
 * main thread is never told about it.
 */
export function sideChatBrief(input: {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly sourceRunOrdinal: number;
}): string {
  const parent = JSON.stringify(input.parentThreadId);
  return [
    `Side chat: this thread is a side chat of ${quotedTitle(input.parentTitle)} (thread ${input.parentThreadId}), forked after its run ${input.sourceRunOrdinal}.`,
    "The main thread keeps working and does not know about you; answer here without disrupting it.",
    "You share its checkout, so do not edit files or start long-running work unless the user asks.",
    `It may have moved on since the fork. When you need its current state, or the user says it progressed, read it with t3_thread_read({threadId:${parent},view:"messages"}).`,
    `Report back only when the user asks, or when a finding clearly changes its current work: t3_thread_send({threadId:${parent},mode:"auto",message}) steers its running turn with a short, self-contained message, or starts a turn if it is idle; t3_thread_merge_back({targetThreadId:${parent}}) instead hands this conversation over with the user's next message there, without waking it.`,
  ].join(" ");
}

/**
 * The note a side chat's provider input starts with on the first turn of each
 * native conversation. Empty for other threads, later turns, slash commands,
 * and side chats whose main thread is gone. Derived from projections, so it
 * needs no stored state.
 */
export const sideChatTurnNote = Effect.fn("orchestrationV2.sideChatTurnNote")(
  function* (input: {
    readonly projectionStore: SideChatNoteReads;
    readonly thread: SideChatThread;
    readonly userText: string;
    readonly firstTurnInNativeConversation: boolean;
  }) {
    const origin = sideChatOrigin(input.thread);
    if (
      origin === null ||
      !input.firstTurnInNativeConversation ||
      startsWithSlashCommand(input.userText)
    ) {
      return "";
    }
    const parent = yield* input.projectionStore.getThreadRecords(origin.parentThreadId, ["runs"]);
    if (parent.thread.deletedAt !== null) return "";
    const sourceRun = parent.runs.find((run) => run.id === origin.sourceRunId);
    if (sourceRun === undefined) return "";
    return sideChatBrief({
      parentThreadId: origin.parentThreadId,
      parentTitle: parent.thread.title,
      sourceRunOrdinal: sourceRun.ordinal,
    });
  },
  // The note is advisory: a missing parent or failed read never blocks the turn.
  (effect, input) =>
    effect.pipe(
      Effect.catch((error) =>
        error._tag === "ProjectionStoreThreadNotFoundError"
          ? Effect.succeed("")
          : Effect.logWarning("Skipped the side chat note", {
              threadId: input.thread.id,
              error,
            }).pipe(Effect.as("")),
      ),
    ),
);
