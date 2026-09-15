import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { resolveThreadListV2Status } from "./threadListV2";

export function ThreadSideTaskOverview({
  threads,
  onSelect,
}: {
  threads: readonly EnvironmentThreadShell[];
  onSelect: (thread: EnvironmentThreadShell) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (threads.length === 0) return null;
  const statuses = threads.map(resolveThreadListV2Status);
  const working = statuses.filter((status) => status === "working").length;
  const attention = statuses.filter(
    (status) => status === "approval" || status === "input" || status === "failed",
  ).length;
  return (
    <View className="mx-5 mb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-9 flex-row items-center gap-2"
      >
        <SymbolView name={expanded ? "chevron.down" : "chevron.right"} size={10} />
        <Text className="text-xs text-foreground-secondary">Side tasks {threads.length}</Text>
        <View className="ml-auto flex-row gap-2">
          {working > 0 && (
            <Text className="text-xs text-adaptive-sky-600-400">{working} working</Text>
          )}
          {attention > 0 && (
            <Text className="text-xs text-warning-foreground">{attention} need attention</Text>
          )}
        </View>
      </Pressable>
      {expanded && (
        <View className="ml-3 border-l border-border pl-2">
          {threads.map((thread) => {
            const status = resolveThreadListV2Status(thread);
            return (
              <Pressable
                key={thread.id}
                accessibilityRole="button"
                onPress={() => onSelect(thread)}
                className="min-h-11 flex-row items-center gap-2 px-2"
              >
                <Text numberOfLines={1} className="flex-1 text-sm">
                  {thread.title}
                </Text>
                <Text className="text-xs text-foreground-secondary">
                  {status === "approval"
                    ? "Needs approval"
                    : status === "input"
                      ? "Needs input"
                      : status === "working"
                        ? "Working"
                        : status === "failed"
                          ? "Failed"
                          : "Ready"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}
