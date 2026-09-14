import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadContextTransfer, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  ArchiveIcon,
  ChevronDownIcon,
  GitBranchIcon,
  HistoryIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  ShareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useSideChatActions } from "../hooks/useSideChatActions";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThread, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useRightPanelStore } from "../rightPanelStore";
import { Button } from "./ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "./ui/menu";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "./ui/alert-dialog";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

const decodeTransfer = Schema.decodeUnknownOption(ThreadContextTransfer);
const STATUS_LABEL = {
  requested: "Preparing context…",
  prepared: "Ready for next turn",
  delivering: "Being included in context",
  delivered: "Included in context",
  failed: "Preparation failed",
  cancelled: "Cancelled",
} satisfies Record<ThreadContextTransfer["status"], string>;

export function SideChatWorkspace({
  threadRef,
  embedded = false,
}: {
  threadRef: ScopedThreadRef;
  embedded?: boolean;
}) {
  const thread = useThread(threadRef);
  const shells = useThreadShells();
  const { environments } = useEnvironments();
  const { createSideChat, openThread, refreshContext, shareContext, cancelContext } =
    useSideChatActions();
  const { archiveThread, unarchiveThread, deleteThread } = useThreadActions();
  const [busy, setBusy] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const parentThreadId = thread?.parentThreadId;
  const parentRef = useMemo(
    () => (parentThreadId ? scopeThreadRef(threadRef.environmentId, parentThreadId) : null),
    [parentThreadId, threadRef.environmentId],
  );
  const parent = useThread(parentRef);
  const children = shells.filter(
    (candidate) =>
      candidate.environmentId === threadRef.environmentId &&
      candidate.parentThreadId === threadRef.threadId &&
      !candidate.archivedAt,
  );
  const environment = environments.find(
    (candidate) => candidate.environmentId === threadRef.environmentId,
  );
  const supportsSideChats =
    environment?.serverConfig?.environment.capabilities.threadSideChats === true;
  const sourceProvider = environment?.serverConfig?.providers.find(
    (provider) => provider.instanceId === thread?.modelSelection.instanceId,
  );
  const canCreate =
    supportsSideChats && sourceProvider?.driver === "codex" && thread?.session != null;
  const answers =
    thread?.messages.filter(
      (message) =>
        message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
    ) ?? [];
  const transfers = [
    { target: thread, targetRef: threadRef },
    ...(parent && parentRef ? [{ target: parent, targetRef: parentRef }] : []),
  ]
    .flatMap(({ target, targetRef }) =>
      (target?.activities ?? []).flatMap((activity) => {
        if (!activity.kind.startsWith("side-chat.context.")) return [];
        const decoded = decodeTransfer(activity.payload);
        if (Option.isNone(decoded)) return [];
        const transfer = decoded.value;
        const outgoing = targetRef.threadId !== threadRef.threadId;
        if (
          outgoing &&
          (transfer.sourceThreadId !== threadRef.threadId || transfer.direction !== "to-parent")
        )
          return [];
        return [
          {
            activity,
            transfer,
            targetRef,
            outgoing,
          },
        ];
      }),
    )
    .toSorted((a, b) => b.activity.createdAt.localeCompare(a.activity.createdAt));
  const pending = transfers.filter(
    ({ transfer }) =>
      transfer.status === "prepared" ||
      transfer.status === "requested" ||
      transfer.status === "delivering",
  );
  const visibleTransfers = showHistory
    ? transfers
    : transfers.filter(
        ({ transfer }) =>
          transfer.status === "prepared" ||
          transfer.status === "requested" ||
          transfer.status === "delivering" ||
          transfer.status === "failed",
      );
  const refreshing = transfers.some(
    ({ transfer, outgoing }) =>
      !outgoing && transfer.direction === "from-parent" && transfer.status === "requested",
  );
  const running = thread?.session?.status === "running" || thread?.session?.status === "starting";

  async function run(action: () => Promise<unknown>, success?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      if (success) toastManager.add({ type: "success", title: success, timeout: 4000 });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Side chat action failed",
        description: cause instanceof Error ? cause.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  const close = () => {
    if (parentRef)
      useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadRef.threadId}`);
  };
  const share = (answer: (typeof answers)[number]) =>
    run(async () => {
      const result = await shareContext({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, messageId: answer.id },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({
        type: "success",
        title: "Answer queued for parent",
        description: "It will be included in the next turn.",
        timeout: 5000,
        actionProps: { children: "Review", onClick: () => setContextOpen(true) },
      });
    });
  const alreadyQueued = (answer: (typeof answers)[number]) =>
    pending.some(({ outgoing, transfer }) => outgoing && transfer.text === answer.text);

  return (
    <section aria-label="Side chats" className="@container shrink-0">
      <div className="flex min-w-0 items-center gap-1 border-b bg-background px-3 py-1.5 text-xs">
        {parentRef ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="mr-auto flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground hover:text-foreground"
                    disabled={!parent}
                    onClick={() => void openThread(parentRef)}
                  />
                }
              >
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="truncate">{parent?.title ?? "Parent unavailable"}</span>
              </TooltipTrigger>
              <TooltipPopup>
                {parent
                  ? "Open parent conversation"
                  : "Restore the parent from Settings → Archived threads"}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={refreshing ? "Updating context" : "Update context"}
                    disabled={busy || refreshing || !thread?.session || !parent}
                    onClick={() =>
                      void run(async () => {
                        const result = await refreshContext({
                          environmentId: threadRef.environmentId,
                          input: { threadId: threadRef.threadId },
                        });
                        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      }, "Context refresh requested")
                    }
                  />
                }
              >
                <RefreshCwIcon className="size-3.5" />
                <span className="@max-md:hidden">
                  {refreshing ? "Updating…" : "Update context"}
                </span>
              </TooltipTrigger>
              <TooltipPopup>Prepare fresh parent context for your next message</TooltipPopup>
            </Tooltip>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Share answer"
                    disabled={busy || answers.length === 0 || !parent}
                  />
                }
              >
                <ShareIcon className="size-3.5" />
                <span className="@max-md:hidden">Share answer</span>
                <ChevronDownIcon className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end" className="w-72">
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  Queue an answer for the parent's next turn
                </p>
                {answers.toReversed().map((answer, index) => (
                  <MenuItem
                    key={answer.id}
                    disabled={alreadyQueued(answer)}
                    onClick={() => void share(answer)}
                    className="flex-col items-start gap-1"
                  >
                    <span className="text-xs text-muted-foreground">
                      {alreadyQueued(answer)
                        ? "Already queued"
                        : index === 0
                          ? "Latest answer"
                          : "Earlier answer"}
                    </span>
                    <span className="line-clamp-2 text-xs">{answer.text.slice(0, 180)}</span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          </>
        ) : null}
        {!embedded && children.length > 0 ? (
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost" />}>
              <GitBranchIcon className="size-3.5" />
              Side chats <span className="text-muted-foreground">{children.length}</span>
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="start" className="max-w-72">
              {children.map((child) => (
                <MenuItem
                  key={child.id}
                  onClick={() => void openThread(scopeThreadRef(child.environmentId, child.id))}
                >
                  <span className="truncate">{child.title}</span>
                </MenuItem>
              ))}
              <MenuSeparator />
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Archived chats are in Settings → Archived threads.
              </p>
            </MenuPopup>
          </Menu>
        ) : null}
        {transfers.length > 0 ? (
          <Popover open={contextOpen} onOpenChange={setContextOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={
                    pending.length ? `Context, ${pending.length} pending` : "Context history"
                  }
                />
              }
            >
              <HistoryIcon className="size-3.5" />
              Context
              {pending.length > 0 ? (
                <span className="rounded bg-primary/10 px-1 text-primary">{pending.length}</span>
              ) : null}
            </PopoverTrigger>
            <PopoverPopup align="end" className="w-96 max-w-[calc(100vw-2rem)]">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Shared context</h3>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label="Close context"
                  onClick={() => setContextOpen(false)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                Pending updates are included when you send the next message in the receiving chat.
              </p>
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {visibleTransfers.length === 0 ? (
                  <p className="py-3 text-xs text-muted-foreground">No pending updates.</p>
                ) : null}
                {visibleTransfers.map(({ activity, transfer, targetRef, outgoing }) => (
                  <div
                    key={`${targetRef.threadId}:${transfer.transferId}`}
                    className="rounded-md border p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {outgoing
                          ? "To parent"
                          : transfer.direction === "from-parent"
                            ? "From parent"
                            : "From side chat"}
                      </span>
                      {transfer.status === "prepared" &&
                      !transfer.transferId.startsWith("side-chat-initial:") ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          title="Remove this update from the next turn"
                          onClick={() =>
                            void run(async () => {
                              const result = await cancelContext({
                                environmentId: targetRef.environmentId,
                                input: {
                                  threadId: targetRef.threadId,
                                  transferId: transfer.transferId,
                                },
                              });
                              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                            }, "Context update cancelled")
                          }
                        >
                          <XIcon className="size-3" />
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                    <p
                      className={`mt-1 text-xs ${transfer.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {STATUS_LABEL[transfer.status]}
                    </p>
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        View details ·{" "}
                        {new Date(activity.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </summary>
                      <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                        {transfer.text ??
                          transfer.detail ??
                          "Preparing context from the source conversation."}
                      </p>
                    </details>
                  </div>
                ))}
              </div>
              <Button
                size="xs"
                variant="ghost"
                className="mt-3"
                onClick={() => setShowHistory(!showHistory)}
              >
                {showHistory ? "Hide history" : "Show history"}
              </Button>
            </PopoverPopup>
          </Popover>
        ) : null}
        {parentRef ? (
          <Menu>
            <MenuTrigger
              render={<Button size="xs" variant="ghost" aria-label="Side chat actions" />}
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {embedded ? (
                <MenuItem onClick={close}>
                  <XIcon className="size-3.5" />
                  Close tab
                </MenuItem>
              ) : null}
              <MenuItem
                disabled={busy || running}
                onClick={() =>
                  void run(async () => {
                    const result = await archiveThread(threadRef);
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    close();
                    toastManager.add({
                      type: "success",
                      title: "Side chat archived",
                      description: "Restore it from Settings → Archived threads.",
                      timeout: 6000,
                      actionProps: {
                        children: "Undo",
                        onClick: () =>
                          void run(async () => {
                            const restored = await unarchiveThread(threadRef);
                            if (restored._tag === "Failure")
                              throw squashAtomCommandFailure(restored);
                            await openThread(threadRef);
                          }),
                      },
                    });
                  })
                }
              >
                <ArchiveIcon className="size-3.5" />
                Archive side chat
              </MenuItem>
              <MenuSeparator />
              <MenuItem disabled={busy || running} onClick={() => setDeleteOpen(true)}>
                <Trash2Icon className="size-3.5" />
                Delete side chat…
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {!embedded ? (
          <Tooltip>
            <TooltipTrigger render={<span className="ml-auto inline-flex" />}>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !canCreate}
                onClick={() => void run(() => createSideChat(threadRef))}
              >
                <MessageSquarePlusIcon className="size-3.5" />
                New side chat
              </Button>
            </TooltipTrigger>
            <TooltipPopup>
              {!supportsSideChats
                ? "Update this environment's server to use side chats"
                : canCreate
                  ? "Start a side chat with inherited context"
                  : "Start a Codex conversation before creating a side chat"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {parentRef && thread?.messages.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Choose Codex or Claude, then send a message to bring in the parent context. This chat
          shares the parent's checkout.
        </p>
      ) : null}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this side chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{thread?.title}” and its conversation history will be removed. The shared checkout is
              kept. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleteOpen(false)}>
              Keep chat
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await deleteThread(threadRef);
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  setDeleteOpen(false);
                  close();
                })
              }
            >
              Delete side chat
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
