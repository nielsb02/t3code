import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { HistoryIcon, Trash2Icon } from "lucide-react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShells, waitForThreadShell } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

/**
 * Micro fork: the side chat entries of a thread's "add panel surface" menu. Closed side chats
 * are archived threads; they stay listed here to reopen or delete, and are never deleted
 * automatically.
 */
export function SideChatMenuItems(props: { readonly parentRef: ScopedThreadRef }) {
  return (
    <>
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger>
          <HistoryIcon />
          Closed side chats
        </MenuSubTrigger>
        <MenuSubPopup className="w-72 max-w-72">
          <ClosedSideChats parentRef={props.parentRef} />
        </MenuSubPopup>
      </MenuSub>
    </>
  );
}

/** Mounted only while the submenu is open, so the archive is read on demand. */
function ClosedSideChats(props: { readonly parentRef: ScopedThreadRef }) {
  const { parentRef } = props;
  const environmentIds = (() => [parentRef.environmentId])();
  const { snapshots, isLoading, error } = useArchivedThreadSnapshots(environmentIds);
  const live = useThreadShells();
  const { unarchiveThread, deleteThread } = useThreadActions();
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const archived = snapshots.flatMap(({ environmentId, snapshot }) =>
    snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
  );
  const all = [
    ...live.filter((thread) => thread.environmentId === parentRef.environmentId),
    ...archived,
  ];
  const descendants = new Set([parentRef.threadId]);
  for (const parentId of descendants) {
    for (const thread of all) {
      if (thread.lineage.sideChat === true && thread.lineage.parentThreadId === parentId) {
        descendants.add(thread.id);
      }
    }
  }
  const closed = archived
    .filter(
      (thread) =>
        thread.lineage.sideChat === true && descendants.has(thread.id) && thread.deletedAt === null,
    )
    .sort((left, right) =>
      (right.archivedAt ?? right.createdAt).localeCompare(left.archivedAt ?? left.createdAt),
    );

  if (closed.length === 0) {
    return (
      <MenuItem disabled>
        {isLoading
          ? "Loading…"
          : error
            ? "Could not load closed side chats"
            : "No closed side chats"}
      </MenuItem>
    );
  }

  const remove = async (sideChatRef: ScopedThreadRef, title: string) => {
    const localApi = readLocalApi();
    if (confirmThreadDelete && localApi) {
      const confirmed = await localApi.dialogs.confirm(
        [`Delete side chat "${title}"?`, "This permanently clears its conversation history."].join(
          "\n",
        ),
        { variant: "destructive" },
      );
      if (!confirmed) return;
    }
    const result = await deleteThread(sideChatRef);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not delete the side chat" });
    }
  };

  const reopen = async (sideChatRef: ScopedThreadRef) => {
    const chain = [sideChatRef.threadId];
    const seen = new Set(chain);
    for (const threadId of chain) {
      const parentId = all.find((thread) => thread.id === threadId)?.lineage.parentThreadId;
      if (parentId == null || parentId === parentRef.threadId || seen.has(parentId)) break;
      seen.add(parentId);
      chain.push(parentId);
    }
    for (const threadId of chain.toReversed()) {
      const result = await unarchiveThread(scopeThreadRef(sideChatRef.environmentId, threadId));
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not reopen the side chat" });
        return;
      }
    }
    if (await waitForThreadShell(sideChatRef)) {
      useRightPanelStore.getState().openSideChat(parentRef, sideChatRef.threadId);
    } else {
      toastManager.add({
        type: "error",
        title: "The reopened side chat did not reach this client",
      });
    }
  };

  return closed.map((sideChat) => {
    const sideChatRef = scopeThreadRef(sideChat.environmentId, sideChat.id);
    return (
      <MenuItem key={sideChat.id} onClick={() => void reopen(sideChatRef)}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{sideChat.title}</span>
          <span className="text-muted-foreground text-xs">
            Closed {formatRelativeTimeLabel(sideChat.archivedAt ?? sideChat.createdAt)}
          </span>
        </span>
        <button
          type="button"
          aria-label={`Delete ${sideChat.title}`}
          className="text-muted-foreground hover:text-destructive -me-1 rounded p-1"
          onClick={(event) => {
            // Deleting is the only way a side chat goes away; it keeps the menu open.
            event.preventDefault();
            event.stopPropagation();
            void remove(sideChatRef, sideChat.title);
          }}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </MenuItem>
    );
  });
}
