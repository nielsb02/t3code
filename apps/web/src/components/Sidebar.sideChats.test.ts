import { describe, expect, it } from "vite-plus/test";
import { summarizeSideChatActivity } from "./Sidebar.sideChats";

const ready = { session: null, hasPendingApprovals: false, hasPendingUserInput: false };

describe("side task activity", () => {
  it("keeps idle tasks quiet and shows ongoing background work", () => {
    expect(
      summarizeSideChatActivity([
        ready,
        { ...ready, backgroundLiveness: "working" },
        { ...ready, backgroundLiveness: "monitoring" },
      ]),
    ).toEqual({ working: 1, monitoring: 1, attention: 0 });
  });
  it("counts tasks needing a response once, ahead of background work", () => {
    expect(
      summarizeSideChatActivity([
        {
          ...ready,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          backgroundLiveness: "working",
        },
        { ...ready, hasPendingUserInput: true },
      ]),
    ).toEqual({ working: 0, monitoring: 0, attention: 2 });
  });
  it("has no activity for an empty family", () => {
    expect(summarizeSideChatActivity([])).toEqual({ working: 0, monitoring: 0, attention: 0 });
  });
});
