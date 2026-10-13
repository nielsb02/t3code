import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
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
  ServerConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { isSidebarNestedThread, resolveSidebarThreadStatus } from "./components/Sidebar.logic";

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

/**
 * Collapses the sidebar's status model into the coarse set Micro Manager
 * shows. `resolveSidebarThreadStatus` is the single source of truth for what
 * the thread is doing; this only decides which of its states block the user.
 */
export function desktopSessionStatus(
  thread: EnvironmentThreadShell,
): DesktopSessionSummary["status"] {
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
    case "input":
      return "blocked";
    case "working":
    case "waiting":
      return "working";
    case "failed":
    case "limited":
      return "error";
    case "ready":
      break;
  }
  // Ready means no run is active, so a proposed plan is waiting on the user.
  if (thread.hasActionableProposedPlan && thread.interactionMode === "plan") return "blocked";
  return thread.latestRun?.status === "completed" ? "done" : "idle";
}

/** Whether the thread belongs in the sidebar's pinned and active lists. */
export function isDesktopSidebarThread(
  thread: EnvironmentThreadShell,
  capabilities:
    | Pick<ServerConfig["environment"]["capabilities"], "threadSettlement" | "threadSnooze">
    | undefined,
  now: string,
): boolean {
  return (
    thread.archivedAt === null &&
    !isSidebarNestedThread(thread) &&
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
    for (const source of snapshot?.threads ?? []) {
      const thread = presentThreadShell(environmentId, source);
      // Subagents and side chats live inside their parent's chat, not in the session list.
      if (thread.archivedAt !== null || isSidebarNestedThread(thread)) continue;
      available.add(scopedThreadKey({ environmentId, threadId: thread.id }));
      sessions.push({
        threadId: thread.id,
        title: thread.title,
        status: desktopSessionStatus(thread),
        updatedAt: thread.latestUserMessageAt ?? thread.latestRun?.requestedAt ?? thread.updatedAt,
        isPinned: thread.pinnedAt != null,
        completionId: thread.latestRun?.runId ?? thread.latestRun?.completedAt ?? null,
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
