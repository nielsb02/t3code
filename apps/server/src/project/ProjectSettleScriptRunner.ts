import type { OrchestrationReadModel, ProjectScript, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { projectScriptRuntimeEnv, settleProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export type ProjectSettleScriptPlan =
  | { readonly kind: "none" }
  | { readonly kind: "skipped" | "failed"; readonly detail: string }
  | {
      readonly kind: "ready";
      readonly scripts: readonly ProjectScript[];
      readonly cwd: string;
      readonly env: Record<string, string>;
    };

export interface ProjectSettleScriptResult {
  readonly kind: "completed" | "failed";
  readonly detail: string;
}

export class ProjectSettleScriptRunner extends Context.Service<
  ProjectSettleScriptRunner,
  {
    readonly prepare: (input: {
      readonly threadId: ThreadId;
      readonly readModel: OrchestrationReadModel;
    }) => Effect.Effect<ProjectSettleScriptPlan>;
    readonly execute: (input: {
      readonly script: ProjectScript;
      readonly cwd: string;
      readonly env: Record<string, string>;
    }) => Effect.Effect<ProjectSettleScriptResult>;
  }
>()("t3/project/ProjectSettleScriptRunner") {}

const failure = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.succeed({ kind: "failed" as const, detail: Cause.pretty(cause).slice(0, 8_000) });

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const backgroundLiveness = yield* ThreadBackgroundLivenessService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;

  const prepare: ProjectSettleScriptRunner["Service"]["prepare"] = Effect.fn(
    "ProjectSettleScriptRunner.prepare",
  )(function* ({ threadId, readModel }) {
    const thread = readModel.threads.find((candidate) => candidate.id === threadId);
    const project = readModel.projects.find((candidate) => candidate.id === thread?.projectId);
    if (!thread || !project) return { kind: "none" } as const;
    const scripts = settleProjectScripts(yield* settings.getSettings, project);
    if (scripts.length === 0) return { kind: "none" } as const;
    if (backgroundLiveness.getThreadBackgroundLiveness(thread.id) !== null) {
      return {
        kind: "skipped",
        detail: "This thread still has live background work in its worktree.",
      } as const;
    }
    if (
      thread.session &&
      thread.session.status !== "stopped" &&
      thread.session.runtimeMode !== thread.runtimeMode
    ) {
      return {
        kind: "skipped",
        detail: "A provider permission change is still pending in this worktree.",
      } as const;
    }
    if (!thread.worktreePath) {
      return {
        kind: "skipped",
        detail: "Settle actions require a worktree; local checkouts are preserved.",
      } as const;
    }
    const cwd = yield* fs.realPath(thread.worktreePath);
    const projectRoot = yield* fs.realPath(project.workspaceRoot);
    if (cwd === projectRoot) {
      return {
        kind: "skipped",
        detail: "Settle actions do not run in the project's primary checkout.",
      } as const;
    }
    const projects = new Map(readModel.projects.map((candidate) => [candidate.id, candidate]));
    for (const other of readModel.threads) {
      if (
        other.id === thread.id ||
        other.deletedAt !== null ||
        ((other.archivedAt !== null || other.settledOverride === "settled") &&
          other.session?.status !== "starting" &&
          other.session?.status !== "running" &&
          (other.session === null ||
            other.session.status === "stopped" ||
            other.session.runtimeMode === other.runtimeMode) &&
          backgroundLiveness.getThreadBackgroundLiveness(other.id) === null)
      )
        continue;
      const otherCwd = other.worktreePath ?? projects.get(other.projectId)?.workspaceRoot;
      if (!otherCwd) continue;
      const canonicalOther = yield* fs
        .realPath(otherCwd)
        .pipe(Effect.orElseSucceed(() => path.resolve(otherCwd)));
      if (canonicalOther === cwd) {
        return {
          kind: "skipped",
          detail: `Settle actions skipped because active thread '${other.title}' (${other.id}) shares this checkout.`,
        } as const;
      }
    }
    return {
      kind: "ready",
      scripts,
      cwd,
      env: projectScriptRuntimeEnv({
        project: { cwd: projectRoot },
        worktreePath: cwd,
        extraEnv: { T3CODE_THREAD_ID: thread.id },
      }),
    } as const;
  }, Effect.catchCause(failure));

  const execute: ProjectSettleScriptRunner["Service"]["execute"] = Effect.fn(
    "ProjectSettleScriptRunner.execute",
  )(function* ({ script, cwd, env }) {
    const result = yield* processRunner.run({
      command: platform === "win32" ? (environment.ComSpec ?? "cmd.exe") : "/bin/sh",
      args: platform === "win32" ? ["/d", "/s", "/c", script.command] : ["-c", script.command],
      cwd,
      env: { ...environment, ...env },
      timeout: "2 minutes",
      maxOutputBytes: 8_000,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 8_000);
    if (result.timedOut || result.code !== 0) {
      return {
        kind: "failed",
        detail: [
          result.timedOut
            ? "Command timed out after two minutes."
            : `Command exited with code ${result.code ?? "unknown"}.`,
          output,
        ]
          .filter(Boolean)
          .join("\n"),
      } as const;
    }
    return { kind: "completed", detail: output || "Command completed successfully." } as const;
  }, Effect.catchCause(failure));

  return ProjectSettleScriptRunner.of({ prepare, execute });
});

export const layer = Layer.effect(ProjectSettleScriptRunner, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
