import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  enabledEnvironmentIds,
  type EnvironmentCatalogState,
} from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type {
  DesktopAppSessionListSuccess,
  DesktopAppRendererReady,
  DesktopSessionSummary,
  EnvironmentId,
  OrchestrationThreadShell,
  ServerConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

export type DesktopSidebarOrder = Pick<
  DesktopAppSessionListSuccess,
  "sidebarOrder" | "sidebarOrderReady"
>;
export type DesktopSessionSnapshot = Pick<
  DesktopAppSessionListSuccess,
  "environments" | "sidebarOrder" | "sidebarOrderReady"
>;

/** Survives sidebar unmounts while Settings or another full-window route is open. */
export function createDesktopSidebarOrderAtom() {
  return Atom.make<DesktopSidebarOrder>({ sidebarOrder: [], sidebarOrderReady: false }).pipe(
    Atom.keepAlive,
  );
}

export function desktopSessionStatus(
  thread: OrchestrationThreadShell,
): DesktopSessionSummary["status"] {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan)
    return "blocked";
  const session = thread.session?.status;
  const turn = thread.latestTurn?.state;
  if (session === "error" || turn === "error") return "error";
  if (
    session === "starting" ||
    session === "running" ||
    turn === "running" ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  )
    return "working";
  if (session === "interrupted" || session === "stopped" || turn === "interrupted") return "idle";
  if (turn === "completed") return "done";
  if (session === undefined || session === "idle" || session === "ready") return "idle";
  return "unknown";
}

export function isDesktopSidebarThread(
  thread: OrchestrationThreadShell,
  capabilities:
    | Pick<ServerConfig["environment"]["capabilities"], "threadSettlement" | "threadSnooze">
    | undefined,
  now: string,
): boolean {
  return (
    thread.archivedAt === null &&
    !thread.parentThreadId &&
    !(capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now })) &&
    !(capabilities?.threadSettlement === true && thread.settledOverride === "settled")
  );
}

export function buildDesktopSessionSnapshot(input: {
  readonly catalog: EnvironmentCatalogState;
  readonly readShell: (environmentId: EnvironmentId) => EnvironmentShellState;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly sidebar: DesktopSidebarOrder;
}): DesktopSessionSnapshot | null {
  if (!input.catalog.isReady) return null;
  const available = new Set<string>();
  const environments = Array.from(enabledEnvironmentIds(input.catalog), (environmentId) => {
    const shell = input.readShell(environmentId);
    const snapshot = Option.getOrNull(shell.snapshot);
    const projects = new Map(
      snapshot?.projects.map((project) => [project.id, project.workspaceRoot]),
    );
    const sessions: DesktopSessionSummary[] = [];
    for (const thread of snapshot?.threads ?? []) {
      if (thread.archivedAt !== null) continue;
      available.add(scopedThreadKey({ environmentId, threadId: thread.id }));
      sessions.push({
        threadId: thread.id,
        title: thread.title,
        status: desktopSessionStatus(thread),
        updatedAt: thread.latestUserMessageAt ?? thread.latestTurn?.requestedAt ?? thread.updatedAt,
        isPinned: thread.pinnedAt != null,
        completionId:
          thread.latestTurn?.turnId ??
          thread.latestTurn?.completedAt ??
          thread.latestTurn?.requestedAt ??
          null,
        directory: thread.worktreePath ?? projects.get(thread.projectId) ?? null,
      });
    }
    return {
      environmentId,
      label: input.catalog.entries.get(environmentId)?.target.label ?? "",
      connected: input.isConnected(environmentId),
      freshness: shell.status,
      sessions,
    };
  });
  return {
    environments,
    sidebarOrder: input.sidebar.sidebarOrder.filter((ref) => available.has(scopedThreadKey(ref))),
    sidebarOrderReady: input.sidebar.sidebarOrderReady,
  };
}

export function buildDesktopAppRendererReadiness(input: {
  readonly catalog: EnvironmentCatalogState;
  readonly readShell: (environmentId: EnvironmentId) => EnvironmentShellState;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly hasServerConfig: (environmentId: EnvironmentId) => boolean;
}): DesktopAppRendererReady {
  const readyEnvironmentIds: EnvironmentId[] = [];
  let primaryEnvironmentReady = false;
  if (input.catalog.isReady) {
    for (const environmentId of enabledEnvironmentIds(input.catalog)) {
      if (!input.isConnected(environmentId)) continue;
      const shell = input.readShell(environmentId);
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) continue;
      readyEnvironmentIds.push(environmentId);
      if (
        input.catalog.entries.get(environmentId)?.target._tag === "PrimaryConnectionTarget" &&
        input.hasServerConfig(environmentId)
      ) {
        primaryEnvironmentReady = true;
      }
    }
  }
  return { ready: true, primaryEnvironmentReady, readyEnvironmentIds };
}
