import { describe, expect, it } from "vite-plus/test";
import {
  resolveWorkspaceGitCwd,
  selectWorkspaceRepository,
  updateWorkspaceRepositorySelection,
} from "./workspaceRepositories";

const repositories = [
  { path: ".", cwd: "/real/workspace", available: true },
  { path: "projects/api", cwd: "/real/workspace/projects/api", available: true },
  { path: "projects/web", cwd: "/real/workspace/projects/web", available: true },
];
const plainFolder = repositories.map((repository) => ({
  ...repository,
  available: repository.path !== ".",
}));

describe("workspace repository selection", () => {
  it("starts with the workspace itself while allowing a child to be selected", () => {
    expect(selectWorkspaceRepository(repositories, null)?.path).toBe(".");
    expect(selectWorkspaceRepository(repositories, "projects/web")?.path).toBe("projects/web");
  });
  it("starts with the first repository only when the workspace is not one", () => {
    expect(selectWorkspaceRepository(plainFolder, null)?.path).toBe("projects/api");
    expect(resolveWorkspaceGitCwd("/workspace", null, plainFolder)).toBe(
      "/real/workspace/projects/api",
    );
  });
  it("keeps Git actions on the workspace path while repositories load, resolve or fail", () => {
    // Loading and failed lists are empty; the resolved root keeps the client's path.
    for (const discovered of [[], repositories]) {
      expect(resolveWorkspaceGitCwd("/workspace", null, discovered)).toBe("/workspace");
      expect(resolveWorkspaceGitCwd("/workspace", ".", discovered)).toBe("/workspace");
    }
    expect(resolveWorkspaceGitCwd("/workspace", "projects/web", repositories)).toBe(
      "/real/workspace/projects/web",
    );
    expect(resolveWorkspaceGitCwd("/workspace", "projects/web", [])).toBeNull();
  });
  it("does not silently redirect actions when the selected repository disappears", () => {
    expect(selectWorkspaceRepository(repositories, "projects/removed")).toBeNull();
    expect(
      selectWorkspaceRepository([{ path: "projects/api", available: false }], "projects/api"),
    ).toBeNull();
  });
  it("keeps single-repository workspaces working", () => {
    expect(selectWorkspaceRepository(repositories.slice(0, 1), null)?.path).toBe(".");
    expect(selectWorkspaceRepository([], null)).toBeNull();
  });
});

it("syncs specific choices while all repositories preserves the Git action target", () => {
  let selection = updateWorkspaceRepositorySelection(null, "projects/web");
  expect(selection).toEqual({ path: "projects/web", diffPath: "projects/web" });
  selection = updateWorkspaceRepositorySelection(selection, null);
  expect(selection).toEqual({ path: "projects/web", diffPath: null });
  selection = updateWorkspaceRepositorySelection(selection, ".");
  expect(selection).toEqual({ path: ".", diffPath: "." });
  expect(updateWorkspaceRepositorySelection(null, null)).toEqual({ path: null, diffPath: null });
});
