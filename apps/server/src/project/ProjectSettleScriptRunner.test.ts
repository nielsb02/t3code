import { describe, expect, it, vi } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ProjectScript,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Runner from "./ProjectSettleScriptRunner.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const script: ProjectScript = {
  id: "cleanup",
  name: "Cleanup",
  command: "fixture-cleanup",
  icon: "configure",
  runOnWorktreeCreate: false,
  runOnThreadSettle: true,
};
const threadId = ThreadId.make("thread");
const fixture = (): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: ProjectId.make("project"),
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [script],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "task",
      worktreePath: "/repo/task",
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: "settled",
      settledAt: NOW,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
});
const output = (code = 0, timedOut = false): ProcessRunner.ProcessRunOutput => ({
  stdout: "fixture output",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const testLayer = (
  run: ProcessRunner.ProcessRunner["Service"]["run"] = () => Effect.die("unexpected command"),
  settings = ServerSettings.layerTest(),
) =>
  Layer.effect(Runner.ProjectSettleScriptRunner, Runner.make).pipe(
    Layer.provide(settings),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(
      FileSystem.layerNoop({
        realPath: (path) => Effect.succeed(path === "/alias/task" ? "/repo/task" : path),
      }),
    ),
    Layer.provide(Path.layer),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { PATH: "/fixture/bin" })),
    Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
  );

describe("ProjectSettleScriptRunner", () => {
  it.effect("prepares the canonical worktree and standard project/thread environment", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.ProjectSettleScriptRunner;
      const model = fixture();
      const plan = yield* runner.prepare({
        threadId,
        readModel: { ...model, threads: [{ ...model.threads[0]!, worktreePath: "/alias/task" }] },
      });
      expect(plan).toEqual({
        kind: "ready",
        scripts: [script],
        cwd: "/repo/task",
        env: {
          T3CODE_PROJECT_ROOT: "/repo",
          T3CODE_WORKTREE_PATH: "/repo/task",
          T3CODE_THREAD_ID: "thread",
        },
      });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("never opts projects into inherited machine cleanup actions", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.ProjectSettleScriptRunner;
      const model = fixture();
      expect(
        yield* runner.prepare({
          threadId,
          readModel: { ...model, projects: [{ ...model.projects[0]!, scripts: [] }] },
        }),
      ).toEqual({ kind: "none" });
    }).pipe(
      Effect.provide(
        testLayer(undefined, ServerSettings.layerTest({ defaultProjectScripts: [script] })),
      ),
    ),
  );

  it.effect("skips local and primary checkouts, even when flagged", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.ProjectSettleScriptRunner;
      const model = fixture();
      for (const worktreePath of [null, "/repo"]) {
        expect(
          yield* runner.prepare({
            threadId,
            readModel: { ...model, threads: [{ ...model.threads[0]!, worktreePath }] },
          }),
        ).toMatchObject({ kind: "skipped" });
      }
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("skips canonical checkouts shared by an active thread but permits settled peers", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.ProjectSettleScriptRunner;
      const model = fixture();
      const peer = {
        ...model.threads[0]!,
        id: ThreadId.make("peer"),
        title: "Peer",
        worktreePath: "/alias/task",
      };
      expect(
        yield* runner.prepare({
          threadId,
          readModel: { ...model, threads: [...model.threads, { ...peer, settledOverride: null }] },
        }),
      ).toMatchObject({ kind: "skipped", detail: expect.stringContaining("Peer") });
      expect(
        yield* runner.prepare({
          threadId,
          readModel: { ...model, threads: [...model.threads, peer] },
        }),
      ).toMatchObject({ kind: "ready" });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("skips a queued permission restart", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.ProjectSettleScriptRunner;
      const model = fixture();
      for (const status of ["ready", "stopped"] as const) {
        expect(
          yield* runner.prepare({
            threadId,
            readModel: {
              ...model,
              threads: [
                {
                  ...model.threads[0]!,
                  session: {
                    threadId,
                    status,
                    providerName: "Codex",
                    runtimeMode: "approval-required",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: NOW,
                  },
                },
              ],
            },
          }),
        ).toMatchObject({ kind: status === "ready" ? "skipped" : "ready" });
      }
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("skips live background work even for settled peer threads", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.ProjectSettleScriptRunner;
      const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
      const model = fixture();
      liveness.recordTaskLiveness({
        threadId,
        taskId: "task",
        taskType: "agent",
        status: "running",
        kind: "started",
      });
      expect(yield* runner.prepare({ threadId, readModel: model })).toMatchObject({
        kind: "skipped",
        detail: expect.stringContaining("background"),
      });
      liveness.clearThreadLiveness(threadId);
      liveness.recordTaskLiveness({
        threadId: "peer",
        taskId: "task",
        taskType: "agent",
        status: "running",
        kind: "started",
      });
      expect(
        yield* runner.prepare({
          threadId,
          readModel: {
            ...model,
            threads: [...model.threads, { ...model.threads[0]!, id: ThreadId.make("peer") }],
          },
        }),
      ).toMatchObject({ kind: "skipped", detail: expect.stringContaining("shares") });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("waits for successful command exit and bounds output and runtime", () => {
    const run = vi.fn(() => Effect.succeed(output()));
    return Effect.gen(function* () {
      const runner = yield* Runner.ProjectSettleScriptRunner;
      expect(
        yield* runner.execute({ script, cwd: "/repo/task", env: { T3CODE_THREAD_ID: "thread" } }),
      ).toEqual({ kind: "completed", detail: "fixture output" });
      expect(run).toHaveBeenCalledWith({
        command: "/bin/sh",
        args: ["-c", "fixture-cleanup"],
        cwd: "/repo/task",
        env: { PATH: "/fixture/bin", T3CODE_THREAD_ID: "thread" },
        timeout: "2 minutes",
        maxOutputBytes: 8000,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      });
    }).pipe(Effect.provide(testLayer(run)));
  });

  it.effect("reports failed exits and timeouts without claiming cleanup succeeded", () =>
    Effect.gen(function* () {
      for (const result of [output(12), output(0, true)]) {
        const actual = yield* Effect.gen(function* () {
          const runner = yield* Runner.ProjectSettleScriptRunner;
          return yield* runner.execute({ script, cwd: "/repo/task", env: {} });
        }).pipe(Effect.provide(testLayer(() => Effect.succeed(result))));
        expect(actual).toMatchObject({
          kind: "failed",
          detail: expect.stringContaining(result.timedOut ? "timed out" : "code 12"),
        });
      }
    }),
  );
});
