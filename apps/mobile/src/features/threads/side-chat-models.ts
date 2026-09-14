import type { OrchestrationThreadShell, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderGroup } from "../../lib/modelOptions";

export function sideChatProviderGroups(
  thread: Pick<OrchestrationThreadShell, "parentThreadId" | "session" | "latestTurn">,
  groups: ReadonlyArray<ProviderGroup>,
  selectedInstanceId: string,
  parentInstanceId: ProviderInstanceId | null,
): ReadonlyArray<ProviderGroup> {
  if (thread.parentThreadId && thread.session === null && thread.latestTurn === null) {
    return groups.flatMap((group) => {
      const models = group.models.filter(
        (model) =>
          model.providerDriver === "claudeAgent" ||
          (model.providerDriver === "codex" && model.selection.instanceId === parentInstanceId),
      );
      return models.length > 0 ? [{ ...group, models }] : [];
    });
  }
  return groups.filter((group) => group.providerKey === selectedInstanceId);
}
