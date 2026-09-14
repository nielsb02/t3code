import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { groupSideChats } from "./Sidebar.sideChats";

const thread = (id: string, parent?: string, environment = "one") => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make(environment),
  ...(parent ? { parentThreadId: ThreadId.make(parent) } : {}),
});

describe("side chat families", () => {
  it("places descendants after their parent while preserving sibling and root order", () => {
    const items = [
      thread("child", "root"),
      thread("other"),
      thread("grandchild", "child"),
      thread("root"),
      thread("sibling", "root"),
    ];
    expect(groupSideChats(items).map((item) => item.id)).toEqual([
      "other",
      "root",
      "child",
      "grandchild",
      "sibling",
    ]);
  });
  it("keeps children visible when their parent is in another shelf or environment", () => {
    const items = [thread("child", "root", "two"), thread("root"), thread("orphan", "absent")];
    expect(groupSideChats(items)).toEqual(items);
  });
  it("neither loses nor repeats rows in a cyclic remote snapshot", () => {
    const items = [thread("a", "b"), thread("b", "a")];
    expect(groupSideChats(items)).toEqual(items);
  });
});
