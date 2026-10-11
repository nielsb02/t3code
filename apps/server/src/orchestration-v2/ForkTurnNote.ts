import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "./ProjectionStore.ts";

const EXCERPT_MAX_CHARS = 200;
const LISTED_ORDINALS_MAX = 5;

interface ForkOrigin {
  readonly parentThreadId: ThreadId;
  readonly sourceRunId: RunId;
}

type ForkTurnNoteReads = Pick<
  ProjectionStore.ProjectionStoreV2Shape,
  "getThreadRecords" | "getTimelinePage"
>;
type ForkThread = Pick<
  OrchestrationV2AppThread,
  "id" | "lineage" | "forkedFrom" | "createdAt" | "worktreePath"
>;
type CompletedRun = OrchestrationV2Run & { readonly completedAt: DateTime.Utc };

function forkOrigin(thread: ForkThread): ForkOrigin | null {
  if (thread.lineage.relationshipToParent !== "fork" || thread.forkedFrom?.type !== "run") {
    return null;
  }
  return { parentThreadId: thread.forkedFrom.threadId, sourceRunId: thread.forkedFrom.runId };
}

/**
 * When the fork last looked at its parent: the start of its latest earlier run
 * that reached the provider, or the fork's creation before any such run. Its
 * first run's native fork or portable handoff already covers the source run.
 */
export function forkLastSawParentAt(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "createdAt">;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
  readonly run: Pick<OrchestrationV2Run, "ordinal">;
}): DateTime.Utc {
  const deliveredAttemptIds = new Set(input.providerTurns.map((turn) => turn.runAttemptId));
  const previous = input.runs
    .filter(
      (run) =>
        run.ordinal < input.run.ordinal &&
        run.startedAt !== null &&
        run.activeAttemptId !== null &&
        deliveredAttemptIds.has(run.activeAttemptId),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return previous?.startedAt ?? input.thread.createdAt;
}

/** Parent runs past the fork point that completed after the fork last looked. */
export function unseenParentRuns(input: {
  readonly parentRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly sourceRunOrdinal: number;
  readonly lastSawParentAt: DateTime.Utc;
}): ReadonlyArray<CompletedRun> {
  const seenAt = DateTime.toEpochMillis(input.lastSawParentAt);
  return input.parentRuns
    .filter(
      (run): run is CompletedRun =>
        run.status === "completed" &&
        run.completedAt !== null &&
        run.ordinal > input.sourceRunOrdinal &&
        DateTime.toEpochMillis(run.completedAt) > seenAt,
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
}

function oneLine(text: string): string {
  const compact = text.replaceAll(/\s+/g, " ").trim();
  return compact.length > EXCERPT_MAX_CHARS
    ? `${compact.slice(0, EXCERPT_MAX_CHARS - 3)}...`
    : compact;
}

function describeOrdinals(ordinals: ReadonlyArray<number>): string {
  if (ordinals.length === 1) return `run ${ordinals[0]}`;
  return ordinals.length <= LISTED_ORDINALS_MAX
    ? `runs ${ordinals.join(", ")}`
    : `runs ${ordinals[0]}-${ordinals.at(-1)}`;
}

/** Sent on a fork's first turn in each native conversation, so it knows how to report back. */
export function forkInstructions(input: {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly sourceRunOrdinal: number;
  /** t3_worktree_handoff only moves a thread out of the project's main checkout. */
  readonly inMainCheckout: boolean;
}): string {
  const parent = JSON.stringify(input.parentThreadId);
  return [
    `Side chat: this thread is a fork of ${JSON.stringify(input.parentTitle)} (thread ${input.parentThreadId}) at its run ${input.sourceRunOrdinal}.`,
    input.inMainCheckout
      ? "It shares the parent's checkout, so coordinate before editing files the parent may also change; t3_worktree_handoff moves this thread into its own worktree if you need isolation."
      : "It shares the parent's worktree, so coordinate before editing files the parent may also change.",
    `To report back, finish your answer and call t3_thread_merge_back({targetThreadId:${parent}}). Called during your turn, it merges once the turn completes; the parent receives the context with its next message and is not woken.`,
    `Use t3_thread_send({threadId:${parent},mode:"queue"}) only when the parent must act now.`,
  ].join(" ");
}

/** A pointer to parent progress the fork has not seen; the agent reads the content itself. */
export function parentMovedNotice(input: {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly runOrdinals: ReadonlyArray<number>;
  readonly latestAnswer: string | null;
  readonly afterPosition: number | null;
}): string {
  const count = input.runOrdinals.length;
  const read = JSON.stringify({
    threadId: input.parentThreadId,
    view: "messages",
    ...(input.afterPosition === null ? {} : { afterPosition: input.afterPosition }),
  });
  const excerpt = input.latestAnswer === null ? "" : oneLine(input.latestAnswer);
  return [
    `Parent update: ${JSON.stringify(input.parentTitle)} (thread ${input.parentThreadId}) completed ${count} ${count === 1 ? "run" : "runs"} you have not seen (${describeOrdinals(input.runOrdinals)}).`,
    ...(excerpt === "" ? [] : [`Its latest answer begins: ${JSON.stringify(excerpt)}`]),
    `This is a pointer, not the content. To catch up, call t3_thread_read(${read}).`,
  ].join(" ");
}

/**
 * The note a fork's provider input starts with: instructions on the first turn
 * of each native conversation, and a pointer to parent runs it has not seen.
 * Empty for other threads, slash commands, and forks whose parent is gone.
 * Derived from projections on every start, so it needs no stored state.
 */
export const forkTurnNote = Effect.fn("orchestrationV2.forkTurnNote")(
  function* (input: {
    readonly projectionStore: ForkTurnNoteReads;
    readonly thread: ForkThread;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
    readonly run: Pick<OrchestrationV2Run, "ordinal">;
    readonly userText: string;
    readonly firstTurnInNativeConversation: boolean;
  }) {
    const origin = forkOrigin(input.thread);
    // Slash commands must stay at the start of the prompt.
    if (origin === null || input.userText.trimStart().startsWith("/")) return "";
    const parent = yield* input.projectionStore.getThreadRecords(origin.parentThreadId, ["runs"]);
    if (parent.thread.deletedAt !== null) return "";
    const sourceRun = parent.runs.find((run) => run.id === origin.sourceRunId);
    if (sourceRun === undefined) return "";
    const unseen = unseenParentRuns({
      parentRuns: parent.runs,
      sourceRunOrdinal: sourceRun.ordinal,
      lastSawParentAt: forkLastSawParentAt(input),
    });
    const parentContext = {
      parentThreadId: origin.parentThreadId,
      parentTitle: parent.thread.title,
    };
    const notice =
      unseen.length === 0
        ? ""
        : parentMovedNotice({
            ...parentContext,
            runOrdinals: unseen.map((run) => run.ordinal),
            latestAnswer: yield* latestAssistantText(input.projectionStore, unseen.at(-1)!),
            afterPosition: yield* positionBefore(input.projectionStore, unseen[0]!),
          });
    const instructions = input.firstTurnInNativeConversation
      ? forkInstructions({
          ...parentContext,
          sourceRunOrdinal: sourceRun.ordinal,
          inMainCheckout: input.thread.worktreePath === null,
        })
      : "";
    return [instructions, notice].filter((part) => part !== "").join("\n\n");
  },
  // The note is advisory: a missing parent or failed read never blocks the turn.
  (effect, input) =>
    effect.pipe(
      Effect.catch((error) =>
        error._tag === "ProjectionStoreThreadNotFoundError"
          ? Effect.succeed("")
          : Effect.logWarning("Skipped the fork turn note", {
              threadId: input.thread.id,
              error,
            }).pipe(Effect.as("")),
      ),
    ),
);

const latestAssistantText = (projectionStore: ForkTurnNoteReads, run: OrchestrationV2Run) =>
  projectionStore
    .getThreadRecords(run.threadId, ["turnItems"], {
      turnItemRunIds: [run.id],
      turnItemTypes: ["assistant_message"],
    })
    .pipe(
      Effect.map(
        ({ turnItems }) =>
          turnItems
            .flatMap((item) =>
              item.type === "assistant_message" && item.text.trim() !== "" ? [item] : [],
            )
            .toSorted((left, right) => left.ordinal - right.ordinal)
            .at(-1)?.text ?? null,
      ),
    );

/** The `t3_thread_read` position just before `run`'s request, so reading starts there. */
const positionBefore = (projectionStore: ForkTurnNoteReads, run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const { turnItems } = yield* projectionStore.getThreadRecords(run.threadId, ["turnItems"], {
      turnItemRunIds: [run.id],
      turnItemTypes: ["user_message"],
    });
    const request = turnItems.find((item) => item.type === "user_message");
    if (request === undefined) return null;
    const page = yield* projectionStore.getTimelinePage(run.threadId, {
      itemId: request.id,
      view: "messages",
      limit: 1,
    });
    const position = page.items[0]?.position;
    return position === undefined || position === 0 ? null : position - 1;
  });
