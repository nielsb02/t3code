import { useRightPanelStore } from "../rightPanelStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { readThreadShell, readEnvironmentSupportsSideChats } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { newThreadId } from "../lib/utils";

export function useSideChatActions() {
  const navigate = useNavigate();
  const router = useRouter();
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const refreshContext = useAtomCommand(threadEnvironment.refreshContext, { reportFailure: false });
  const cancelContext = useAtomCommand(threadEnvironment.cancelContext, { reportFailure: false });
  const shareContext = useAtomCommand(threadEnvironment.shareContext, { reportFailure: false });

  const openSideChat = useCallback(
    async (parentRef: ScopedThreadRef, childRef: ScopedThreadRef) => {
      useRightPanelStore.getState().openSideChat(parentRef, childRef.threadId);
      const params = router.state.matches.at(-1)?.params ?? {};
      const current = resolveThreadRouteRef(params);
      if (
        current?.environmentId !== parentRef.environmentId ||
        current.threadId !== parentRef.threadId
      ) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(parentRef),
        });
      }
    },
    [navigate, router],
  );

  const openThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const thread = readThreadShell(threadRef);
      const parentRef = thread?.parentThreadId
        ? scopeThreadRef(threadRef.environmentId, thread.parentThreadId)
        : null;
      if (parentRef && readThreadShell(parentRef)) return openSideChat(parentRef, threadRef);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate, openSideChat],
  );

  const createSideChat = useCallback(
    async (parentRef: ScopedThreadRef) => {
      if (!readEnvironmentSupportsSideChats(parentRef.environmentId))
        throw new Error("Update this environment's server to use side chats.");
      const parent = readThreadShell(parentRef);
      if (!parent) throw new Error("The parent thread is no longer available.");
      const threadId = newThreadId();
      const result = await create({
        environmentId: parentRef.environmentId,
        input: {
          threadId,
          parentThreadId: parent.id,
          projectId: parent.projectId,
          title: "New thread",
          modelSelection: parent.modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          branch: parent.branch,
          worktreePath: parent.worktreePath,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      await openSideChat(parentRef, scopeThreadRef(parentRef.environmentId, threadId));
    },
    [create, openSideChat],
  );

  return { createSideChat, openThread, refreshContext, shareContext, cancelContext };
}
