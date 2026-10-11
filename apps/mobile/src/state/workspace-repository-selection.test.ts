import { describe, expect, it } from "vite-plus/test";
import {
  resolveWorkspaceRepositoryFilter,
  resolveWorkspaceRepositoryPath,
  updateWorkspaceRepositorySelection,
  resolveWorkspaceGitCwd,
} from "./workspace-repository-selection";

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
  it("defaults to the first repository only when the workspace is not one", () => {
    const plainFolder = [
      { path: ".", cwd: "/workspace", available: false },
      { path: "projects/api", cwd: "/workspace/projects/api", available: false },
      { path: "projects/web", cwd: "/workspace/projects/web", available: true },
    ];
    expect(resolveWorkspaceRepositoryPath(null, plainFolder)).toBe("projects/web");
    expect(resolveWorkspaceGitCwd("/workspace", null, plainFolder)).toBe("/workspace/projects/web");
    expect(resolveWorkspaceRepositoryPath(null, repositories)).toBe(".");
  });
  it("keeps Git on the workspace while repositories load or fail, unless a child was chosen", () => {
    expect(resolveWorkspaceRepositoryPath(null, [])).toBe(".");
    expect(resolveWorkspaceGitCwd("/workspace", null, [])).toBe("/workspace");
    expect(resolveWorkspaceGitCwd("/workspace", ".", [])).toBe("/workspace");
    expect(resolveWorkspaceGitCwd("/workspace", "projects/api", [])).toBeNull();
  });
  it("does not redirect a removed or unavailable child's actions to the wrapper", () => {
    expect(resolveWorkspaceGitCwd("/workspace", "projects/missing", repositories)).toBeNull();
    expect(
      resolveWorkspaceGitCwd("/workspace", "projects/api", [
        { ...repositories[1]!, available: false },
      ]),
    ).toBeNull();
  });
  it("keeps review and Git on a specific repository while All preserves the Git target", () => {
    const child = updateWorkspaceRepositorySelection(
      { path: null, diffPath: null },
      "projects/api",
    );
    expect(resolveWorkspaceGitCwd("/workspace", child.path, repositories)).toBe(
      "/workspace/projects/api",
    );
    expect(resolveWorkspaceRepositoryFilter(child.diffPath, repositories)).toBe("projects/api");
    const all = updateWorkspaceRepositorySelection(child, null);
    expect(resolveWorkspaceRepositoryFilter(all.diffPath, repositories)).toBeNull();
    expect(resolveWorkspaceGitCwd("/workspace", all.path, repositories)).toBe(
      "/workspace/projects/api",
    );
    const root = updateWorkspaceRepositorySelection(all, ".");
    expect(resolveWorkspaceRepositoryFilter(root.diffPath, repositories)).toBe(".");
    expect(resolveWorkspaceGitCwd("/workspace", root.path, repositories)).toBe("/workspace");
  });
  it("falls back to All for unavailable review targets without redirecting Git actions", () => {
    const selected = updateWorkspaceRepositorySelection(
      { path: null, diffPath: null },
      "projects/api",
    );
    for (const available of [
      repositories.slice(0, 1),
      repositories.map((repo) => ({ ...repo, available: repo.path === "." })),
    ]) {
      expect(resolveWorkspaceRepositoryFilter(selected.diffPath, available)).toBeNull();
      expect(resolveWorkspaceGitCwd("/workspace", selected.path, available)).toBeNull();
    }
  });
});
