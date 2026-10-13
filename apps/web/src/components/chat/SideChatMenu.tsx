import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { HistoryIcon, MessagesSquareIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useRightPanelStore } from "../../rightPanelStore";
import { waitForThreadShell } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";

/**
 * Micro fork: the side chat entries of a thread's "add panel surface" menu. Closed side chats
 * are archived threads; they stay listed here to reopen or delete, and are never deleted
 * automatically.
 */
export function SideChatMenuItems(props: {
  readonly parentRef: ScopedThreadRef;
  readonly shortcutLabel: string | null;
  readonly onNewSideChat: () => void;
}) {
  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={props.onNewSideChat}>
        <MessagesSquareIcon />
        Side chat
        {props.shortcutLabel ? <MenuShortcut>{props.shortcutLabel}</MenuShortcut> : null}
      </MenuItem>
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
  const environmentIds = useMemo(() => [parentRef.environmentId], [parentRef.environmentId]);
  const { snapshots, isLoading, error } = useArchivedThreadSnapshots(environmentIds);
  const { unarchiveThread, deleteThread } = useThreadActions();
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const closed = useMemo(
    () =>
      snapshots
        .flatMap(({ environmentId, snapshot }) =>
          snapshot.threads
            .filter(
              (thread) =>
                thread.sideChat === true &&
                thread.deletedAt === null &&
                thread.lineage.parentThreadId === parentRef.threadId,
            )
            .map((thread) => presentThreadShell(environmentId, thread)),
        )
        .sort((left, right) =>
          (right.archivedAt ?? right.createdAt).localeCompare(left.archivedAt ?? left.createdAt),
        ),
    [parentRef.threadId, snapshots],
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
    const result = await unarchiveThread(sideChatRef);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not reopen the side chat" });
      return;
    }
    if (await waitForThreadShell(sideChatRef)) {
      useRightPanelStore.getState().openSideChat(parentRef, sideChatRef.threadId);
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
