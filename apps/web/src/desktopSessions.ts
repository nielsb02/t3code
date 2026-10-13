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

const SIDE_CHAT_LIFT_RANK: Partial<Record<DesktopSessionSummary["status"], number>> = {
  working: 1,
  blocked: 2,
};

/**
 * Micro fork: a thread's session shows its own status unless one of its open side chats is
 * working or needs the user, which lifts it. Needs you outranks working, which outranks the
 * thread's own status.
 */
export function withSideChatStatus(
  status: DesktopSessionSummary["status"],
  sideChatStatuses: Iterable<DesktopSessionSummary["status"]>,
): DesktopSessionSummary["status"] {
  const rank = (value: DesktopSessionSummary["status"]) => SIDE_CHAT_LIFT_RANK[value] ?? 0;
  let lifted = status;
  for (const sideChatStatus of sideChatStatuses) {
    if (rank(sideChatStatus) > rank(lifted)) lifted = sideChatStatus;
  }
  return lifted;
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
    const threads = (snapshot?.threads ?? []).map((source) =>
      presentThreadShell(environmentId, source),
    );
    const sideChatStatuses = new Map<string, DesktopSessionSummary["status"][]>();
    for (const thread of threads) {
      const parentThreadId = thread.lineage.parentThreadId;
      if (thread.sideChat !== true || thread.archivedAt !== null || parentThreadId === null) {
        continue;
      }
      const statuses = sideChatStatuses.get(parentThreadId) ?? [];
      statuses.push(desktopSessionStatus(thread));
      sideChatStatuses.set(parentThreadId, statuses);
    }
    for (const thread of threads) {
      // Subagents and side chats live inside their parent's chat, not in the session list.
      if (thread.archivedAt !== null || isSidebarNestedThread(thread)) continue;
      available.add(scopedThreadKey({ environmentId, threadId: thread.id }));
      sessions.push({
        threadId: thread.id,
        title: thread.title,
        status: withSideChatStatus(
          desktopSessionStatus(thread),
          sideChatStatuses.get(thread.id) ?? [],
        ),
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
