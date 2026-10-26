// @effect-diagnostics nodeBuiltinImport:off
import { FileFinder } from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

const appendSeparator = (input: string) =>
  Effect.map(HostProcess.Platform, (platform) =>
    input.endsWith("/") || input.endsWith("\\")
      ? input
      : `${input}${platform === "win32" ? "\\" : "/"}`,
  );

it.layer(layerTest, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("repositories", () => {
    it.effect("shares concurrent discovery without retaining completed membership", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const path = yield* Path.Path;
        yield* writeTextFile(
          cwd,
          "t3.json",
          '{\n// Repository settings\n"repositories":{"paths":["projects/app"]},\n}',
        );
        yield* writeTextFile(cwd, "projects/app/file.txt");
        yield* git(path.join(cwd, "projects/app"), ["init"]);
        const vcs = yield* VcsProcess.VcsProcess;
        const calls = vi.spyOn(vcs, "run");
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        yield* Effect.all(
          [
            entries.listRepositories({ cwd }),
            entries.listRepositories({ cwd }),
            entries.listRepositories({ cwd }),
          ],
          { concurrency: "unbounded" },
        );
        expect(
          calls.mock.calls.filter(([input]) => input.operation === "WorkspaceRepositories.list"),
        ).toHaveLength(2);
        yield* writeTextFile(cwd, "t3.json", "{}");
        expect(
          (yield* entries.listRepositories({ cwd })).repositories.map((repo) => repo.path),
        ).toEqual(["."]);
      }),
    );
    it.effect("uses a stable locale for repository discovery diagnostics", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const vcs = yield* VcsProcess.VcsProcess;
        const calls = vi.spyOn(vcs, "run");
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* entries.listRepositories({ cwd });
        expect(result.repositories).toMatchObject([{ path: ".", available: false }]);
        const discoveryCalls = calls.mock.calls.filter(
          ([input]) => input.operation === "WorkspaceRepositories.list",
        );
        expect(discoveryCalls.length).toBeGreaterThan(0);
        for (const [input] of discoveryCalls) expect(input.env).toMatchObject({ LC_ALL: "C" });
      }),
    );
    it.effect("explains that configured paths resolving to the root are already included", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        for (const relative of [".", "./"]) {
          yield* writeTextFile(cwd, "t3.json", `{"repositories":{"paths":["${relative}"]}}`);
          const error = yield* entries.listRepositories({ cwd }).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "WorkspaceRepositoryDiscoveryError",
            message: `Repository path '${relative}' resolves to the workspace root, which is already included.`,
          });
        }
      }),
    );
    it.effect("discovers initialized nested submodules through their declarations", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const source = yield* makeTempDir({ git: true });
        const path = yield* Path.Path;
        yield* writeTextFile(source, "module.txt", "nested module contents");
        yield* git(source, ["add", "."]);
        yield* git(source, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "initial",
        ]);
        yield* git(cwd, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          source,
          "packages/module",
        ]);
        yield* git(path.join(cwd, "packages/module"), [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          source,
          "vendor/nested",
        ]);
        yield* writeTextFile(cwd, "t3.json", '{"repositories":{"includeSubmodules":true}}');
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(
          (yield* entries.listRepositories({ cwd })).repositories.map((repo) => [
            repo.path,
            repo.kind,
            repo.available,
          ]),
        ).toEqual([
          [".", "root", true],
          ["packages/module", "submodule", true],
          ["packages/module/vendor/nested", "submodule", true],
        ]);
        expect((yield* entries.list({ cwd })).entries).toContainEqual({
          path: "packages/module/vendor/nested/module.txt",
          kind: "file",
        });
      }),
    );
    it.effect("preserves Git access for projects opened inside a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "packages/app/t3.json", '{"repositories":{"paths":["src"]}}');
        yield* writeTextFile(cwd, "packages/app/src/index.ts");
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* entries.listRepositories({ cwd: path.join(cwd, "packages/app") });
        expect(result.repositories.map((repo) => [repo.path, repo.available])).toEqual([
          [".", true],
          ["src", false],
        ]);
      }),
    );
    it.effect("ranks matches across repositories and includes configured directory roots", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "t3.json", '{"repositories":{"paths":["projects/app"]}}');
        yield* writeTextFile(cwd, ".gitignore", "projects/\n");
        yield* writeTextFile(cwd, "docs/target-old.txt");
        yield* writeTextFile(cwd, "projects/app/target.txt");
        yield* git(path.join(cwd, "projects/app"), ["init"]);
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const ranked = yield* entries.search({ cwd, query: "target.txt", limit: 1, kind: "file" });
        expect(ranked.entries).toEqual([{ path: "projects/app/target.txt", kind: "file" }]);
        expect(ranked.entries[0]).not.toHaveProperty("score");
        expect(ranked.truncated).toBe(true);
        for (const kind of [undefined, "directory"] as const) {
          const result = yield* entries.search({
            cwd,
            query: "projects/app",
            limit: 10,
            ...(kind ? { kind } : {}),
          });
          expect(result.entries).toContainEqual({ path: "projects/app", kind: "directory" });
        }
        const files = yield* entries.search({
          cwd,
          query: "projects/app",
          limit: 10,
          kind: "file",
        });
        expect(files.entries).toEqual([{ path: "projects/app/target.txt", kind: "file" }]);
        const images = yield* entries.search({
          cwd,
          query: "projects/app",
          limit: 10,
          imageOnly: true,
        });
        expect(images.entries).toEqual([]);
      }),
    );
    it.effect("refreshes the normalized root index when repository discovery fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "file.txt");
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        yield* entries.list({ cwd });
        yield* entries.searchContents({
          cwd,
          query: "needle",
          limit: 10,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });
        yield* writeTextFile(cwd, "t3.json", '{"repositories":{"paths":["../escape"]}}');
        const scan = vi.spyOn(FileFinder.prototype, "scanFiles");
        yield* entries.refresh(`${cwd}/.`);
        expect(scan).toHaveBeenCalledTimes(2);
      }),
    );
    it.effect("discovers only configured direct repository roots and updates membership", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        yield* writeTextFile(cwd, "t3.json", '{"repositories":{"paths":["projects/*"]}}');
        yield* writeTextFile(cwd, ".gitignore", "projects/\n");
        yield* writeTextFile(cwd, "projects/app/src/App.ts", "workspace needle");
        yield* git(path.join(cwd, "projects/app"), ["init"]);
        yield* writeTextFile(cwd, "projects/app/.gitignore", "secret.txt\n");
        yield* writeTextFile(cwd, "projects/app/secret.txt", "workspace needle");
        yield* writeTextFile(cwd, "projects/plain/file.txt");
        yield* writeTextFile(cwd, "elsewhere/other/file.txt");
        yield* git(path.join(cwd, "elsewhere/other"), ["init"]);
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* entries.listRepositories({ cwd });
        expect(result.repositories.map((repo) => repo.path)).toEqual([".", "projects/app"]);
        expect((yield* entries.list({ cwd })).entries).toContainEqual({
          path: "projects/app/src/App.ts",
          kind: "file",
        });
        expect(
          (yield* entries.list({ cwd })).entries.some((entry) => entry.path.endsWith("secret.txt")),
        ).toBe(false);
        expect(
          (yield* entries.search({ cwd, query: "projects/app/src/App.ts", limit: 10 })).entries,
        ).toContainEqual({ path: "projects/app/src/App.ts", kind: "file" });
        expect((yield* entries.search({ cwd, query: "App.ts", limit: 10 })).entries).toContainEqual(
          { path: "projects/app/src/App.ts", kind: "file" },
        );
        const contentResult = yield* entries.searchContents({
          cwd,
          query: "needle",
          limit: 10,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });
        expect(contentResult.matches.map((match) => match.path)).toEqual([
          "projects/app/src/App.ts",
        ]);
        yield* fs.remove(path.join(cwd, "projects/app"), { recursive: true });
        expect(
          (yield* entries.listRepositories({ cwd })).repositories.map((repo) => repo.path),
        ).toEqual(["."]);
      }),
    );
    it.effect(
      "rejects escaping and recursive configuration instead of reporting a clean workspace",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir();
          const entries = yield* WorkspaceEntries.WorkspaceEntries;
          yield* writeTextFile(cwd, "t3.json", '{"repositories":{"paths":["../other"]}}');
          const escaping = yield* entries.listRepositories({ cwd }).pipe(Effect.flip);
          expect(escaping._tag).toBe("WorkspaceRepositoryDiscoveryError");
          yield* writeTextFile(cwd, "t3.json", '{"repositories":{"paths":["projects/**"]}}');
          const recursive = yield* entries.listRepositories({ cwd }).pipe(Effect.flip);
          expect(recursive._tag).toBe("WorkspaceRepositoryDiscoveryError");
        }),
    );
    it.effect(
      "keeps the root's files searchable when the repository configuration is unusable",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir({ git: true });
          yield* writeTextFile(cwd, "src/index.ts", "workspace needle");
          const entries = yield* WorkspaceEntries.WorkspaceEntries;
          for (const config of [
            '{"repositories":{"paths":["projects/**"]}}',
            '{"repositories":{"paths":["../escape"]}}',
            '{"repositories":{"paths":[',
          ]) {
            yield* writeTextFile(cwd, "t3.json", config);
            const error = yield* entries.listRepositories({ cwd }).pipe(Effect.flip);
            expect(error._tag).toBe("WorkspaceRepositoryDiscoveryError");
            expect((yield* entries.list({ cwd })).entries).toContainEqual({
              path: "src/index.ts",
              kind: "file",
            });
            expect(
              (yield* entries.search({ cwd, query: "index.ts", limit: 10 })).entries,
            ).toContainEqual({ path: "src/index.ts", kind: "file" });
            const contents = yield* entries.searchContents({
              cwd,
              query: "needle",
              limit: 10,
              caseSensitive: false,
              wholeWord: false,
              useRegex: false,
            });
            expect(contents.matches.map((match) => match.path)).toEqual(["src/index.ts"]);
          }
        }),
    );
    it.effect("searches workspaces that declare no repositories without spawning Git", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, "src/index.ts", "workspace needle");
        const vcs = yield* VcsProcess.VcsProcess;
        const calls = vi.spyOn(vcs, "run");
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        for (const config of [
          undefined,
          "{}",
          '{"repositories":{}}',
          '{"repositories":{"paths":[],"includeSubmodules":false}}',
        ]) {
          if (config !== undefined) yield* writeTextFile(cwd, "t3.json", config);
          expect(
            (yield* entries.search({ cwd, query: "index.ts", limit: 10 })).entries,
          ).toContainEqual({ path: "src/index.ts", kind: "file" });
          yield* entries.list({ cwd });
          yield* entries.searchContents({
            cwd,
            query: "needle",
            limit: 10,
            caseSensitive: false,
            wholeWord: false,
            useRegex: false,
          });
        }
        expect(calls).not.toHaveBeenCalled();
      }),
    );
    it.effect("reuses repository membership across searches until t3.json changes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "t3.json", '{"repositories":{"paths":["projects/app"]}}');
        yield* writeTextFile(cwd, ".gitignore", "projects/\n");
        yield* writeTextFile(cwd, "projects/app/target.txt");
        yield* git(path.join(cwd, "projects/app"), ["init"]);
        yield* writeTextFile(cwd, "projects/other/other.txt");
        yield* git(path.join(cwd, "projects/other"), ["init"]);
        const vcs = yield* VcsProcess.VcsProcess;
        const calls = vi.spyOn(vcs, "run");
        const discoveries = () =>
          calls.mock.calls.filter(([input]) => input.operation === "WorkspaceRepositories.members")
            .length;
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(
          (yield* entries.search({ cwd, query: "target.txt", limit: 10, kind: "file" })).entries,
        ).toEqual([{ path: "projects/app/target.txt", kind: "file" }]);
        const first = discoveries();
        expect(first).toBeGreaterThan(0);
        yield* entries.search({ cwd, query: "target", limit: 10 });
        yield* entries.list({ cwd });
        expect(discoveries()).toBe(first);
        yield* writeTextFile(
          cwd,
          "t3.json",
          '{"repositories":{"paths":["projects/app","projects/other"]}}',
        );
        expect(
          (yield* entries.search({ cwd, query: "other.txt", limit: 10, kind: "file" })).entries,
        ).toEqual([{ path: "projects/other/other.txt", kind: "file" }]);
        expect(discoveries()).toBeGreaterThan(first);
      }),
    );
    it.effect(
      "includes linked worktrees, rejects symlink escapes, and reports uninitialized submodules",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir({ git: true });
          const source = yield* makeTempDir({ git: true });
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          yield* git(source, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
          ]);
          yield* fs.makeDirectory(path.join(cwd, "projects"));
          yield* git(source, ["worktree", "add", "--detach", path.join(cwd, "projects/task")]);
          yield* fs.symlink(source, path.join(cwd, "projects/escape"));
          yield* writeTextFile(
            cwd,
            "t3.json",
            '{"repositories":{"paths":["projects/*"],"includeSubmodules":true}}',
          );
          yield* writeTextFile(
            cwd,
            ".gitmodules",
            '[submodule "missing"]\n path = packages/missing\n url = https://example.com/missing.git\n',
          );
          const entries = yield* WorkspaceEntries.WorkspaceEntries;
          const result = yield* entries.listRepositories({ cwd });
          expect(result.repositories.map((repo) => [repo.path, repo.kind, repo.available])).toEqual(
            [
              [".", "root", true],
              ["packages/missing", "submodule", false],
              ["projects/task", "repository", true],
            ],
          );
        }),
    );
  });

  describe("list", () => {
    it.effect("lists immediate children including ignored and empty directories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "tracked.txt");
        yield* git(cwd, ["add", "tracked.txt"]);
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\n.env\ntracked.txt\n");
        yield* writeTextFile(cwd, ".env", "secret=value");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* fileSystem.makeDirectory(path.join(cwd, "empty"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const root = yield* workspaceEntries.list({ cwd, directoryPath: "" });
        expect(root.entries).toEqual(
          expect.arrayContaining([
            { path: ".env", kind: "file", ignored: true },
            { path: "node_modules", kind: "directory", ignored: true },
            { path: "src", kind: "directory" },
            { path: "empty", kind: "directory" },
            { path: "tracked.txt", kind: "file" },
          ]),
        );
        expect(root.entries.some((entry) => entry.path.includes("/"))).toBe(false);
        expect(root.entries.some((entry) => entry.path === ".git")).toBe(false);
        expect(root.truncated).toBe(false);
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "node_modules/pkg" })).toEqual({
          entries: [{ path: "node_modules/pkg/index.js", kind: "file", ignored: true }],
          truncated: false,
        });
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "empty" })).toEqual({
          entries: [],
          truncated: false,
        });
      }),
    );

    it.effect("classifies ignored children using their nested repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const child = path.join(cwd, "projects/app");
        yield* fs.makeDirectory(child, { recursive: true });
        yield* git(child, ["init"]);
        yield* writeTextFile(child, ".gitignore", "build/\n");
        yield* writeTextFile(child, "build/output.js");
        yield* writeTextFile(child, "src/index.ts");
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.list({ cwd, directoryPath: "projects/app" });
        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: "projects/app/build", kind: "directory", ignored: true },
            { path: "projects/app/src", kind: "directory" },
          ]),
        );
      }),
    );

    it.effect("labels the children of wide folders exactly as git does for each child", () =>
      Effect.gen(function* () {
        // Above 1,000 children, listing first asks whether the whole folder is ignored.
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        yield* writeTextFile(
          cwd,
          ".gitignore",
          "node_modules/\ndist/\n\\[id\\]/\n*.map\nfoo\n!foo/\n",
        );
        yield* Effect.forEach(
          [
            "node_modules",
            "dist",
            "[id]",
            "src",
            ...(platform !== "win32" ? [":foo"] : []),
          ].flatMap((directory) =>
            Array.from({ length: 1001 }, (_, index) => `${directory}/pkg-${index}.js`),
          ),
          (relativePath) => writeTextFile(cwd, relativePath),
          { concurrency: 32, discard: true },
        );
        for (const relativePath of [
          "dist/kept.js",
          "dist/vendored/index.js",
          "i/page.tsx",
          "[id]/page.tsx",
          "src/bundle.map",
        ]) {
          yield* writeTextFile(cwd, relativePath);
        }
        yield* git(cwd, ["add", "-f", "dist/kept.js", "dist/vendored/index.js", "i/page.tsx"]);
        if (platform !== "win32") {
          yield* fileSystem.symlink(path.join(cwd, "src"), path.join(cwd, "node_modules/link"));
        }

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        for (const { directoryPath, ignored, except } of [
          { directoryPath: "node_modules", ignored: true, except: [] },
          { directoryPath: "dist", ignored: true, except: ["dist/kept.js", "dist/vendored"] },
          // git reads `[id]/page.tsx` as a pathspec, which matches the tracked `i/page.tsx`.
          { directoryPath: "[id]", ignored: true, except: ["[id]/page.tsx"] },
          { directoryPath: "src", ignored: false, except: ["src/bundle.map"] },
          ...(platform !== "win32"
            ? [
                // git refuses to classify paths beyond a symlink, so nothing there is labelled.
                { directoryPath: "node_modules/link", ignored: false, except: [] },
                // Leading : is pathspec magic; Git sees foo/pkg-0.js, unignored by !foo/.
                { directoryPath: ":foo", ignored: false, except: [] },
              ]
            : []),
        ]) {
          const { entries } = yield* workspaceEntries.list({ cwd, directoryPath });
          expect(entries.length, directoryPath).toBeGreaterThan(1000);
          expect(
            entries
              .filter((entry) => (entry.ignored === true) !== ignored)
              .map((entry) => entry.path)
              .toSorted(),
            directoryPath,
          ).toEqual(except);
        }
      }),
    );

    it.effect("lists a host folder and its parent, each from its own root", () =>
      Effect.gen(function* () {
        const parent = yield* makeTempDir();
        const path = yield* Path.Path;
        yield* writeTextFile(parent, "linked/notes.md");
        yield* writeTextFile(parent, "sibling/readme.md");
        const linked = path.join(parent, "linked");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(yield* workspaceEntries.list({ cwd: linked, directoryPath: "" })).toEqual({
          entries: [{ path: "notes.md", kind: "file" }],
          truncated: false,
        });
        const up = yield* workspaceEntries.list({ cwd: parent, directoryPath: "" });
        expect(up.entries.map((entry) => entry.path).toSorted()).toEqual(["linked", "sibling"]);
        const escape = yield* workspaceEntries
          .list({ cwd: linked, directoryPath: "../sibling" })
          .pipe(Effect.flip);
        expect(escape._tag).toBe("WorkspaceEntriesReadDirectoryError");
      }),
    );

    it.effect(
      "rejects directory traversal, git internals, and symlinks outside the workspace",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir();
          const outside = yield* makeTempDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, ".git/HEAD");
          const platform = yield* HostProcess.Platform;
          if (platform !== "win32") yield* fileSystem.symlink(outside, path.join(cwd, "external"));
          const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
          for (const directoryPath of [
            "../",
            outside,
            ".git",
            "missing",
            ...(platform !== "win32" ? ["external"] : []),
          ]) {
            const error = yield* workspaceEntries.list({ cwd, directoryPath }).pipe(Effect.flip);
            expect(error._tag).toBe("WorkspaceEntriesReadDirectoryError");
          }
        }),
    );

    it.effect("includes images and other binary files in non-git workspace indexes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const imagePaths = ["photo.png", "photo.jpg", "photo.jpeg"];
        const binaryPaths = [...imagePaths, "document.pdf", "archive.zip", "data.bin"];
        for (const filePath of binaryPaths) {
          yield* writeTextFile(cwd, filePath, "\0binary contents\n");
        }
        yield* writeTextFile(cwd, "notes.txt", "plain text\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const expectedPaths = [...binaryPaths, "notes.txt"].toSorted();
        const listed = yield* workspaceEntries.list({ cwd });
        expect(listed.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(listed.truncated).toBe(false);

        const searched = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          kind: "file",
        });
        expect(searched.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(searched.truncated).toBe(false);

        const images = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          imageOnly: true,
        });
        expect(images.entries.map((entry) => entry.path).toSorted()).toEqual(imagePaths.toSorted());
        expect(images.truncated).toBe(false);
      }),
    );
  });

  describe("listIgnoredFiles", () => {
    it.effect("lists ignored files with sizes and skips wholly ignored folders", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\n.env*\n");
        yield* writeTextFile(cwd, ".env", "A=1");
        yield* writeTextFile(cwd, "apps/web/index.ts", "y");
        yield* git(cwd, ["add", "apps/web/index.ts"]);
        yield* writeTextFile(cwd, "apps/web/.env.local", "B=22");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js", "x");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(yield* workspaceEntries.listIgnoredFiles({ cwd })).toEqual({
          files: [
            { path: ".env", byteLength: 3 },
            { path: "apps/web/.env.local", byteLength: 4 },
          ],
          truncated: false,
        });
      }),
    );
  });

  describe("search", () => {
    it.effect("applies the file filter before limiting search results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-file-limit-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "src/internal.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 1,
          kind: "file",
        });

        // Native ranking can put either matching file first.
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.kind).toBe("file");
        expect(["src/index.ts", "src/internal.ts"]).toContain(result.entries[0]?.path);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("excludes gitignored paths for git repositories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-gitignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* writeTextFile(cwd, "ignored.txt", "ignore me");
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths).not.toContain("ignored.txt");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("convex/"))).toBe(false);
      }),
    );

    it.effect("excludes tracked paths that match ignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({
          prefix: "t3code-workspace-tracked-gitignore-",
          git: true,
        });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* git(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
        yield* writeTextFile(cwd, ".gitignore", ".convex/\n");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );
  });

  describe("searchContents", () => {
    it.effect("returns content matches with file paths, line numbers, and ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-search-" });
        yield* writeTextFile(
          cwd,
          "src/shapes.ts",
          "export const square = 4;\nexport const Square = 16;\nexport const squareSize = 8;\n",
        );
        yield* writeTextFile(cwd, "src/other.ts", "const circle = true;\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: false,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches.map((match) => [match.path, match.lineNumber])).toEqual([
          ["src/shapes.ts", 1],
          ["src/shapes.ts", 2],
        ]);
        expect(result.matches[0]?.matchRanges).toEqual([{ start: 13, end: 19 }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("honors case sensitivity and gitignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-ignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "square\nSquare\n");
        yield* writeTextFile(cwd, "ignored.txt", "Square\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({ path: "src/keep.ts", lineNumber: 2 });
      }),
    );

    it.effect("finds later whole-word matches in a file after rejected raw matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-late-whole-word-" });
        yield* writeTextFile(cwd, "src/words.ts", `${"afoo\n".repeat(10)}foo\n`);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 1,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 11,
            matchRanges: [{ start: 0, end: 3 }],
          }),
        ]);
      }),
    );

    it.effect("treats astral-plane letters as whole word characters", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-astral-word-" });
        yield* writeTextFile(cwd, "src/words.ts", "𐐀foo foo foo𐐀\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 1,
            matchRanges: [{ start: 6, end: 9 }],
          }),
        ]);
      }),
    );

    it.effect("matches punctuation-edged whole-word queries including adjacent occurrences", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "-foo- -foo- -foo-\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "-foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
          matchRanges: [
            { start: 0, end: 5 },
            { start: 6, end: 11 },
            { start: 12, end: 17 },
          ],
        });
      }),
    );

    it.effect("caps matches per file so one dense file cannot fill the page", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-per-file-cap-" });
        yield* writeTextFile(cwd, "src/dense.ts", "needle\n".repeat(300));
        yield* writeTextFile(cwd, "src/other.ts", "needle\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "needle",
          limit: 500,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        const byPath = new Map<string, number>();
        for (const match of result.matches) {
          byPath.set(match.path, (byPath.get(match.path) ?? 0) + 1);
        }
        expect(byPath.get("src/dense.ts")).toBe(100);
        expect(byPath.get("src/other.ts")).toBe(1);
      }),
    );

    it.effect("preserves regex escapes during case-insensitive searches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-" });
        yield* writeTextFile(cwd, "src/shapes.ts", "Square\nsquare\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "\\SQUARE",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
      }),
    );

    it.effect("maps multi-byte lines to string-indexed ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-multibyte-" });
        yield* writeTextFile(cwd, "src/notes.ts", 'const label = "héllo wörld";\n');

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "wörld",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        const match = result.matches[0]!;
        const range = match.matchRanges[0]!;
        expect(match.lineContent.slice(range.start, range.end)).toBe("wörld");
      }),
    );
  });

  describe("browse", () => {
    it.effect("shows dot directories in directory mode and hidden-prefix mode", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-hidden-" });
        yield* writeTextFile(cwd, ".config/settings.json", "{}");
        yield* writeTextFile(cwd, "config/settings.json", "{}");
        const cwdWithSeparator = yield* appendSeparator(cwd);

        const directoryResult = yield* workspaceEntries.browse({
          partialPath: cwdWithSeparator,
        });
        const hiddenPrefixResult = yield* workspaceEntries.browse({
          partialPath: `${cwdWithSeparator}.c`,
        });

        expect(directoryResult.entries.map((entry) => entry.name)).toEqual([".config", "config"]);
        expect(hiddenPrefixResult).toEqual({
          parentPath: cwd,
          entries: [{ name: ".config", fullPath: path.join(cwd, ".config") }],
        });
      }),
    );
  });
});
