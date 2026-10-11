import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2Run,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  forkInstructions,
  forkLastSawParentAt,
  parentMovedNotice,
  unseenParentRuns,
} from "./ForkTurnNote.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 9, 12, minute));
const parentThreadId = ThreadId.make("thread:parent");

function run(
  ordinal: number,
  extra: Partial<Pick<OrchestrationV2Run, "status" | "startedAt" | "completedAt">> = {},
): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    threadId: parentThreadId,
    ordinal,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status: "completed",
    startedAt: at(ordinal * 10),
    completedAt: at(ordinal * 10 + 5),
    ...extra,
  } as OrchestrationV2Run;
}

it("counts completed parent runs past the fork point that finished after the fork last looked", () => {
  const forkCreatedAt = at(22);
  const unseen = unseenParentRuns({
    parentRuns: [
      run(1),
      run(2),
      // Past the fork point, but finished before the fork existed.
      run(3, { completedAt: at(21) }),
      run(4),
      run(5, { status: "failed" }),
      run(6, { status: "rolled_back" }),
      run(7, { status: "running", completedAt: null }),
      run(8),
    ],
    sourceRunOrdinal: 2,
    lastSawParentAt: forkCreatedAt,
  });
  assert.deepStrictEqual(
    unseen.map((source) => source.ordinal),
    [4, 8],
  );
});

it("measures from the latest earlier fork run that reached the provider", () => {
  const thread = { createdAt: at(1) };
  const delivered = run(1, { startedAt: at(30) });
  // Started but never accepted by the provider, so the fork never saw a notice there.
  const undelivered = run(2, { startedAt: at(40) });
  const providerTurns = [{ runAttemptId: delivered.activeAttemptId! }];

  assert.deepStrictEqual(
    forkLastSawParentAt({ thread, runs: [delivered, undelivered], providerTurns, run: run(3) }),
    at(30),
  );
  assert.deepStrictEqual(
    forkLastSawParentAt({ thread, runs: [delivered], providerTurns: [], run: run(2) }),
    at(1),
  );
});

it("points at the unseen parent runs without copying them", () => {
  const notice = parentMovedNotice({
    parentThreadId,
    parentTitle: "Fix the build",
    runOrdinals: [4, 5],
    latestAnswer: `Done.\n\n${"x".repeat(400)}`,
    afterPosition: 11,
  });
  assert.include(notice, `"Fix the build" (thread ${parentThreadId}) completed 2 runs`);
  assert.include(notice, "(runs 4, 5)");
  assert.include(
    notice,
    `t3_thread_read({"threadId":"${parentThreadId}","view":"messages","afterPosition":11})`,
  );
  const excerpt = /begins: "([^"]*)"/.exec(notice)?.[1] ?? "";
  assert.isAtMost(excerpt.length, 200);
  assert.isTrue(excerpt.startsWith("Done. xxx") && excerpt.endsWith("..."));

  const many = parentMovedNotice({
    parentThreadId,
    parentTitle: "Fix the build",
    runOrdinals: [3, 4, 6, 7, 8, 9],
    latestAnswer: null,
    afterPosition: null,
  });
  assert.include(many, "completed 6 runs you have not seen (runs 3-9)");
  assert.notInclude(many, "begins");
  assert.include(many, `t3_thread_read({"threadId":"${parentThreadId}","view":"messages"})`);
});

it("keeps fork instructions short and names the parent and the report-back tools", () => {
  const instructions = forkInstructions({
    parentThreadId,
    parentTitle: "Fix the build",
    sourceRunOrdinal: 3,
  });
  assert.isAtMost(instructions.split(/\s+/).length, 120);
  assert.include(instructions, `thread ${parentThreadId}) at its run 3`);
  assert.include(instructions, `t3_thread_merge_back({targetThreadId:"${parentThreadId}"})`);
  assert.include(instructions, `t3_thread_send({threadId:"${parentThreadId}",mode:"queue"})`);
  assert.include(instructions, "t3_worktree_handoff");
});
