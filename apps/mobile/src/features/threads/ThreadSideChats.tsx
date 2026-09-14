import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  ThreadId,
  ThreadContextTransfer,
  type OrchestrationThread,
  type ServerConfig,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const decodeTransfer = Schema.decodeUnknownOption(ThreadContextTransfer);

const TRANSFER_STATUS = {
  requested: "Preparing context",
  prepared: "Ready for the next turn",
  delivering: "Being included in context",
  delivered: "Included in provider context",
  failed: "Context transfer failed",
  cancelled: "Cancelled",
} satisfies Record<ThreadContextTransfer["status"], string>;

export function ThreadSideChats(props: {
  readonly thread: EnvironmentThreadShell;
  readonly detail: OrchestrationThread | null;
  readonly serverConfig: ServerConfig;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const createThread = useAtomCommand(threadEnvironment.create, "create side chat");
  const refreshContext = useAtomCommand(
    threadEnvironment.refreshContext,
    "refresh side chat context",
  );
  const cancelContext = useAtomCommand(threadEnvironment.cancelContext, "cancel shared context");
  const archiveThread = useAtomCommand(threadEnvironment.archive, "archive side chat");
  const [showHistory, setShowHistory] = useState(false);
  const [expandedTransfers, setExpandedTransfers] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const parent = threads.find(
    (thread) =>
      thread.environmentId === props.thread.environmentId &&
      thread.id === props.thread.parentThreadId,
  );
  const children = threads.filter(
    (thread) =>
      thread.environmentId === props.thread.environmentId &&
      thread.parentThreadId === props.thread.id &&
      !thread.archivedAt,
  );
  const driver =
    props.serverConfig.providers.find(
      (provider) => provider.instanceId === props.thread.modelSelection.instanceId,
    )?.driver ?? props.thread.session?.providerName;
  const canCreate =
    driver === "codex" && props.thread.session !== null && props.thread.latestTurn !== null;
  const transfers = (props.detail?.activities ?? []).flatMap((activity) => {
    if (!activity.kind.startsWith("side-chat.context.")) return [];
    const transfer = Option.getOrNull(decodeTransfer(activity.payload));
    return transfer ? [{ ...transfer, createdAt: activity.createdAt }] : [];
  });
  const refreshing = busy || transfers.some((transfer) => transfer.status === "requested");

  const openThread = (threadId: ThreadId) => {
    props.onClose();
    navigation.navigate("Thread", {
      environmentId: String(props.thread.environmentId),
      threadId: String(threadId),
    });
  };

  const handleCreate = async () => {
    if (creating.current || !props.connected || !canCreate) return;
    creating.current = true;
    setBusy(true);
    const threadId = ThreadId.make(uuidv4());
    try {
      const result = await createThread({
        environmentId: props.thread.environmentId,
        input: {
          threadId,
          parentThreadId: props.thread.id,
          projectId: props.thread.projectId,
          title: "New thread",
          modelSelection: props.thread.modelSelection,
          runtimeMode: props.thread.runtimeMode,
          interactionMode: props.thread.interactionMode,
          branch: props.thread.branch,
          worktreePath: props.thread.worktreePath,
        },
      });
      if (result._tag === "Success") openThread(threadId);
      else Alert.alert("Couldn't create side chat", "Check your connection and try again.");
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (creating.current || refreshing || !props.connected) return;
    creating.current = true;
    setBusy(true);
    try {
      const result = await refreshContext({
        environmentId: props.thread.environmentId,
        input: { threadId: props.thread.id },
      });
      if (result._tag !== "Success")
        Alert.alert("Couldn't refresh context", "Check your connection and try again.");
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView className="flex-1 bg-screen">
        <View className="flex-row items-center justify-between px-5 py-3">
          <Text className="text-lg font-t3-bold">Side chats</Text>
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center px-2"
            onPress={props.onClose}
          >
            <Text className="font-t3-medium">Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
          {props.thread.parentThreadId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open parent thread"
              accessibilityState={{ disabled: !parent }}
              disabled={!parent}
              className="min-h-11 justify-center"
              onPress={() => {
                if (props.thread.parentThreadId) openThread(props.thread.parentThreadId);
              }}
            >
              <Text className="text-sm font-t3-medium">
                Parent: {parent?.title ?? "Archived or unavailable"}
              </Text>
              {!parent ? (
                <Text className="text-sm text-foreground-muted">
                  Restore the parent from Archived threads to open it.
                </Text>
              ) : null}
            </Pressable>
          ) : null}
          <Text className="text-sm text-foreground-muted">
            Start a separate conversation with context from a Codex parent. Choose Codex or Claude
            in the new chat's model picker before sending your first message. Side chats share this
            checkout and remain saved when closed.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canCreate || busy || !props.connected }}
            disabled={!canCreate || busy || !props.connected}
            onPress={() => void handleCreate()}
            className="min-h-12 justify-center rounded-xl bg-card px-4"
          >
            <Text
              className={
                canCreate && !busy && props.connected ? "font-t3-medium" : "text-foreground-muted"
              }
            >
              {busy ? "Working…" : "New side chat"}
            </Text>
          </Pressable>
          {!canCreate ? (
            <Text className="text-sm text-foreground-muted">
              {driver === "codex"
                ? "Start a conversation with Codex before creating a side chat."
                : "Context inheritance currently supports Codex parent threads."}
            </Text>
          ) : null}
          {!props.connected ? (
            <Text className="text-sm text-foreground-muted">
              Reconnect to create a side chat or refresh context.
            </Text>
          ) : null}
          {props.thread.parentThreadId ? (
            <View className="gap-2 rounded-xl bg-card p-4">
              <Text className="font-t3-medium">Context from parent</Text>
              <Text className="text-sm text-foreground-muted">
                Refresh prepares a Codex-authored handoff from the parent for your next turn. It
                does not start a response.
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={refreshing || !props.connected}
                accessibilityState={{ disabled: refreshing || !props.connected }}
                onPress={() => void handleRefresh()}
                className="min-h-11 justify-center"
              >
                <Text className="font-t3-medium">
                  {refreshing ? "Preparing context…" : "Update from parent"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {children.length > 0 ? (
            <Text className="font-t3-medium">Side chats ({children.length})</Text>
          ) : null}
          {children.map((child) => (
            <Pressable
              accessibilityRole="button"
              key={child.id}
              className="gap-1 rounded-xl bg-card p-4"
              onPress={() => openThread(child.id)}
            >
              <Text className="font-t3-medium">{child.title}</Text>
              <Text className="text-xs text-foreground-muted">
                {child.session?.status ?? "Ready"}
                {child.archivedAt ? " · Archived" : ""}
              </Text>
            </Pressable>
          ))}
          {transfers.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowHistory(!showHistory)}
              className="min-h-11 justify-center"
            >
              <Text className="font-t3-medium">
                {showHistory ? "Hide context history" : "Show context history"}
              </Text>
            </Pressable>
          ) : null}
          {transfers
            .filter(
              (transfer) =>
                showHistory ||
                transfer.status === "requested" ||
                transfer.status === "prepared" ||
                transfer.status === "delivering" ||
                transfer.status === "failed",
            )
            .map((transfer) => (
              <View key={transfer.transferId} className="gap-2 rounded-xl bg-card p-4">
                <Text className="font-t3-medium">{TRANSFER_STATUS[transfer.status]}</Text>
                <Text className="text-xs text-foreground-muted">
                  {transfer.direction === "from-parent" ? "Context from parent" : "Shared finding"}{" "}
                  · {new Date(transfer.createdAt).toLocaleString()}
                </Text>
                {transfer.status === "prepared" &&
                !transfer.transferId.startsWith("side-chat-initial:") ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel context update"
                    disabled={busy || !props.connected}
                    accessibilityState={{ disabled: busy || !props.connected }}
                    className="min-h-11 justify-center"
                    onPress={() => {
                      setBusy(true);
                      void cancelContext({
                        environmentId: props.thread.environmentId,
                        input: { threadId: props.thread.id, transferId: transfer.transferId },
                      })
                        .then((result) => {
                          if (result._tag !== "Success")
                            Alert.alert(
                              "Couldn't cancel update",
                              "Check your connection and try again.",
                            );
                        })
                        .finally(() => setBusy(false));
                    }}
                  >
                    <Text className="font-t3-medium">Cancel update</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  className="min-h-11 justify-center"
                  onPress={() =>
                    setExpandedTransfers((current) => {
                      const next = new Set(current);
                      if (next.has(transfer.transferId)) next.delete(transfer.transferId);
                      else next.add(transfer.transferId);
                      return next;
                    })
                  }
                >
                  <Text className="text-sm text-foreground-muted">
                    {expandedTransfers.has(transfer.transferId) ? "Hide details" : "View details"}
                  </Text>
                </Pressable>
                {expandedTransfers.has(transfer.transferId) && transfer.detail ? (
                  <Text selectable className="text-sm">
                    {transfer.detail}
                  </Text>
                ) : null}
                {expandedTransfers.has(transfer.transferId) && transfer.text ? (
                  <Text selectable className="text-sm">
                    {transfer.text}
                  </Text>
                ) : null}
              </View>
            ))}
          {props.thread.parentThreadId ? (
            <Pressable
              accessibilityRole="button"
              disabled={
                busy ||
                !props.connected ||
                props.thread.session?.status === "running" ||
                props.thread.session?.status === "starting"
              }
              className="min-h-12 justify-center rounded-xl bg-card px-4"
              onPress={() =>
                Alert.alert(
                  "Archive side chat?",
                  "You can restore it from Archived threads. The shared checkout is kept.",
                  [
                    { text: "Keep chat", style: "cancel" },
                    {
                      text: "Archive",
                      onPress: () => {
                        setBusy(true);
                        void archiveThread({
                          environmentId: props.thread.environmentId,
                          input: { threadId: props.thread.id },
                        })
                          .then((result) => {
                            if (result._tag === "Success") {
                              if (parent) openThread(parent.id);
                              else props.onClose();
                            } else {
                              Alert.alert(
                                "Couldn't archive side chat",
                                "Check your connection and try again.",
                              );
                            }
                          })
                          .finally(() => setBusy(false));
                      },
                    },
                  ],
                )
              }
            >
              <Text className="font-t3-medium">Archive side chat</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
