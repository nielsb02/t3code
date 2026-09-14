import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ProviderGroup } from "../../lib/modelOptions";
import { sideChatProviderGroups } from "./side-chat-models";

const parentThreadId = ThreadId.make("parent");

function group(driver: string, instanceId = driver): ProviderGroup {
  return {
    providerKey: instanceId,
    providerLabel: driver,
    models: [
      {
        key: instanceId,
        label: driver,
        subtitle: "",
        providerKey: instanceId,
        providerLabel: driver,
        providerDriver: driver,
        isDefault: true,
        isLegacy: false,
        capabilities: null,
        selection: { instanceId: ProviderInstanceId.make(instanceId), model: "default" },
      },
    ],
  };
}

const groups = [group("codex"), group("claudeAgent"), group("opencode")];

describe("side chat model selection", () => {
  it("allows Claude before a Codex child starts and excludes unsupported providers", () => {
    const choices = sideChatProviderGroups(
      { parentThreadId, session: null, latestTurn: null },
      groups,
      "codex",
      ProviderInstanceId.make("codex"),
    );
    expect(choices.map((choice) => choice.providerKey)).toEqual(["codex", "claudeAgent"]);
    expect(
      sideChatProviderGroups(
        { parentThreadId, session: null, latestTurn: null },
        groups,
        "claudeAgent",
        ProviderInstanceId.make("codex"),
      ),
    ).toEqual(choices);
  });

  it("keeps existing child sessions bound to their provider even when stopped", () => {
    expect(
      sideChatProviderGroups(
        {
          parentThreadId,
          latestTurn: null,
          session: {
            threadId: ThreadId.make("child"),
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-09-11T12:00:00.000Z",
          },
        },
        groups,
        "claudeAgent",
        ProviderInstanceId.make("codex"),
      ),
    ).toEqual([groups[1]]);
  });

  it("preserves the existing picker behavior for ordinary threads", () => {
    expect(
      sideChatProviderGroups({ session: null, latestTurn: null }, groups, "codex", null),
    ).toEqual([groups[0]]);
  });

  it("offers only the parent's Codex instance while allowing every Claude instance", () => {
    const choices = sideChatProviderGroups(
      { parentThreadId, session: null, latestTurn: null },
      [...groups, group("codex", "codex-other"), group("claudeAgent", "claude-other")],
      "claudeAgent",
      ProviderInstanceId.make("codex"),
    );
    expect(choices.map((choice) => choice.providerKey)).toEqual([
      "codex",
      "claudeAgent",
      "claude-other",
    ]);
  });

  it("does not offer Codex when the parent's instance is unavailable", () => {
    const choices = sideChatProviderGroups(
      { parentThreadId, session: null, latestTurn: null },
      groups,
      "codex",
      null,
    );
    expect(choices.map((choice) => choice.providerKey)).toEqual(["claudeAgent"]);
  });
});
