import { describe, expect, it } from "vite-plus/test";
import { resolveWorkspaceGitCwd } from "./workspace-repository-selection";

describe("workspace Git target", () => {
  const repositories = [
    { path: ".", cwd: "/workspace", available: true },
    { path: "projects/api", cwd: "/workspace/projects/api", available: true },
  ];
  it("keeps wrapper as default and resolves children only from discovery", () => {
    expect(resolveWorkspaceGitCwd("/workspace", null, repositories)).toBe("/workspace");
    expect(resolveWorkspaceGitCwd("/workspace", "projects/api", repositories)).toBe(
      "/workspace/projects/api",
    );
  });
  it("does not redirect a removed or unavailable child's actions to the wrapper", () => {
    expect(resolveWorkspaceGitCwd("/workspace", "projects/missing", repositories)).toBeNull();
    expect(
      resolveWorkspaceGitCwd("/workspace", "projects/api", [
        { ...repositories[1]!, available: false },
      ]),
    ).toBeNull();
  });
});
