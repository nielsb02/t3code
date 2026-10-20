// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectListRepositoriesInput,
  ProjectListRepositoriesResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery, scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as WorkspaceRepositories from "./WorkspaceRepositories.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceRepositories.WorkspaceRepositoryDiscoveryError,
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly listRepositories: (
      input: ProjectListRepositoriesInput,
    ) => Effect.Effect<ProjectListRepositoriesResult, WorkspaceEntriesError>;
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly listIgnoredFiles: (
      input: ProjectListIgnoredFilesInput,
    ) => Effect.Effect<ProjectListIgnoredFilesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

/** Ignored files offered for copying; more than this is a build folder, not config. */
const IGNORED_FILES_LIMIT = 200;

/** Paths sent to one `git check-ignore` call when labelling a folder's children. */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, yield* HostProcess.HomeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(
    expandHomePath(input.cwd, yield* HostProcess.HomeDirectory),
    input.partialPath,
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const listRepositories: WorkspaceEntries["Service"]["listRepositories"] = Effect.fn(
    "WorkspaceEntries.listRepositories",
  )(function* (input) {
    return { repositories: yield* repositories.list(yield* normalizeWorkspaceRoot(input.cwd)) };
  });

  const members = Effect.fn("WorkspaceEntries.members")(function* (cwd: string) {
    return yield* repositories.members(yield* normalizeWorkspaceRoot(cwd));
  });
  const prefix = (repository: WorkspaceRepositories.WorkspaceMember, relative: string) =>
    repository.path === "." ? relative : `${repository.path}/${relative}`;
  const ownership = (
    repository: WorkspaceRepositories.WorkspaceMember,
    all: ReadonlyArray<WorkspaceRepositories.WorkspaceMember>,
  ) => {
    const descendants = all
      .filter(
        (child) =>
          child.path !== repository.path &&
          child.path !== "." &&
          (repository.path === "." || child.path.startsWith(`${repository.path}/`)),
      )
      .map((child) => child.path);
    return (relative: string) => {
      if (descendants.length === 0) return true;
      const fullPath = prefix(repository, relative);
      return !descendants.some((child) => fullPath === child || fullPath.startsWith(`${child}/`));
    };
  };

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.flatMap((root) => fileSystem.realPath(root)),
        Effect.orElseSucceed(() => cwd),
      );
      const currentMembers = yield* repositories.members(normalizedCwd);
      for (const memberCwd of new Set([
        normalizedCwd,
        ...currentMembers.map((member) => member.cwd),
      ])) {
        for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
          const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(memberCwd, variant);
          if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
            continue;
          }
          const recoverRefreshFailure = Effect.fn("WorkspaceEntries.recoverRefreshFailure")(
            function* (
              cause:
                | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
                | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
                | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
            ) {
              yield* Effect.logWarning("Failed to refresh workspace search index", {
                cwd,
                variant,
                cause,
              });
              yield* workspaceSearchIndexes.invalidate(indexKey);
            },
          );
          yield* Effect.gen(function* () {
            const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
            yield* searchIndex.refresh();
          }).pipe(
            Effect.provide(workspaceSearchIndexes.get(indexKey)),
            Effect.catchTags({
              WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
              WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
              WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
            }),
          );
        }
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const all = yield* members(input.cwd);
      const query = normalizeSearchQuery(input.query, { trimLeadingPattern: /^[@./]+/ });
      const results = yield* Effect.forEach(
        all,
        (repository) =>
          Effect.gen(function* () {
            const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
            const owns = ownership(repository, all);
            const repositoryPrefix = repository.path.toLowerCase();
            const localQuery =
              repository.path !== "." &&
              (query === repositoryPrefix || query.startsWith(`${repositoryPrefix}/`))
                ? query.slice(repositoryPrefix.length).replace(/^\//, "")
                : query;
            const result = yield* searchIndex.search(
              localQuery,
              input.limit,
              input.kind,
              input.imageOnly,
            );
            return {
              ...result,
              entries: result.entries.flatMap((entry, index) =>
                owns(entry.path)
                  ? [
                      {
                        entry: { ...entry, path: prefix(repository, entry.path) },
                        score: result.scores[index] ?? 0,
                      },
                    ]
                  : [],
              ),
            };
          }).pipe(
            Effect.provide(
              workspaceSearchIndexes.get(
                WorkspaceSearchIndex.workspaceSearchIndexKey(repository.cwd, "paths"),
              ),
            ),
          ),
        { concurrency: 4 },
      );
      const entries = [
        ...new Map(
          results.flatMap((result) => result.entries).map((ranked) => [ranked.entry.path, ranked]),
        ).values(),
      ];
      if (input.kind !== "file" && !input.imageOnly) {
        for (const repository of all) {
          if (repository.path === ".") continue;
          const score = scoreSubsequenceMatch(repository.path.toLowerCase(), query);
          if (score !== null)
            entries.push({
              entry: { path: repository.path, kind: "directory" },
              score: query === repository.path.toLowerCase() ? Number.MAX_SAFE_INTEGER : -score,
            });
        }
      }
      entries.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
      return {
        entries: entries.slice(0, input.limit).map(({ entry }) => entry),
        truncated: entries.length > input.limit || results.some((result) => result.truncated),
      };
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const all = yield* members(input.cwd);
    const results = yield* Effect.forEach(
      all,
      (repository) =>
        Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          const owns = ownership(repository, all);
          const result = yield* searchIndex.searchContents(input);
          return {
            ...result,
            matches: result.matches
              .filter((match) => owns(match.path))
              .map((match) => ({ ...match, path: prefix(repository, match.path) })),
          };
        }).pipe(
          Effect.provide(
            workspaceSearchIndexes.get(
              WorkspaceSearchIndex.workspaceSearchIndexKey(repository.cwd, "content"),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    const matches = results.flatMap((result) => result.matches);
    const regexFallbackError = results.find(
      (result) => result.regexFallbackError,
    )?.regexFallbackError;
    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || results.some((result) => result.truncated),
      ...(regexFallbackError ? { regexFallbackError } : {}),
    };
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const { entries, throughSymlink } = yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            return {
              entries: children.flatMap((child): ProjectEntry[] => {
                if (child.name === ".git" || (!child.isDirectory() && !child.isFile())) return [];
                return [
                  {
                    path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                    kind: child.isDirectory() ? "directory" : "file",
                  },
                ];
              }),
              // Git refuses to classify paths beyond a symbolic link.
              throughSymlink: relative !== target.relativePath.split("/").join(path.sep),
            };
          },
          catch: toError,
        });
        // Use stdin so large directories cannot exceed the command-line argument limit.
        // Ignore classification is optional in non-git workspaces or when git is unavailable.
        const gitRoot = yield* vcsProcess
          .run({
            operation: "WorkspaceEntries.list",
            command: "git",
            args: ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
            cwd: target.absolutePath,
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          })
          .pipe(
            Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : normalizedCwd)),
            Effect.orElseSucceed(() => normalizedCwd),
          );
        const checkIgnore = (paths: ReadonlyArray<string>) =>
          vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: gitRoot,
              stdin: `${paths.map((relative) => path.relative(gitRoot, path.join(normalizedCwd, relative)) || ".").join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
        // Git consults the index for every path it classifies, which costs hundreds of
        // milliseconds for a `node_modules`-sized folder. Asking about the folder itself answers
        // for every child: `check-ignore` exits 0 only when the folder is ignored and nothing
        // under it is tracked, and an ignored folder hides all of its children. Git reads paths as
        // pathspecs, so a folder whose path has magic (`:foo`) or glob (`[id]`) characters, or
        // one reached through a symlink, can get a different answer per child and still asks git
        // about each.
        if (
          entries.length > IGNORE_CHECK_CHUNK_SIZE &&
          target.relativePath !== "" &&
          !throughSymlink &&
          !/^:|[*?[\\]/.test(target.relativePath) &&
          (yield* checkIgnore([target.relativePath]))?.exitCode === 0
        ) {
          return {
            entries: entries.map((entry) => ({ ...entry, ignored: true })),
            truncated: false,
          };
        }
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
          const result = yield* checkIgnore(
            entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path),
          );
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) {
            if (!ignoredPath) continue;
            ignored.add(
              path
                .relative(normalizedCwd, path.join(gitRoot, ignoredPath))
                .split(path.sep)
                .join("/"),
            );
          }
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      const all = yield* members(input.cwd);
      const results = yield* Effect.forEach(
        all,
        (repository) =>
          Effect.gen(function* () {
            const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
            const owns = ownership(repository, all);
            const result = yield* searchIndex.list();
            return {
              ...result,
              entries: result.entries
                .filter((entry) => owns(entry.path))
                .map((entry) => ({ ...entry, path: prefix(repository, entry.path) })),
            };
          }).pipe(
            Effect.provide(
              workspaceSearchIndexes.get(
                WorkspaceSearchIndex.workspaceSearchIndexKey(repository.cwd, "paths"),
              ),
            ),
          ),
        { concurrency: 4 },
      );
      const entries = new Map(
        results.flatMap((result) => result.entries).map((entry) => [entry.path, entry]),
      );
      for (const repository of all) {
        if (repository.path === ".") continue;
        const segments = repository.path.split("/");
        for (let count = 1; count <= segments.length; count++) {
          const directory = segments.slice(0, count).join("/");
          entries.set(directory, { path: directory, kind: "directory" });
        }
      }
      return {
        entries: [...entries.values()]
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, 25_000),
        truncated: entries.size > 25_000 || results.some((result) => result.truncated),
      };
    },
  );

  const listIgnoredFiles: WorkspaceEntries["Service"]["listIgnoredFiles"] = Effect.fn(
    "WorkspaceEntries.listIgnoredFiles",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    // `--directory` reports a folder holding nothing but ignored files as one
    // `name/` entry, which is how `node_modules` and build output drop out.
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnoredFiles",
        command: "git",
        args: [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
        ],
        cwd: normalizedCwd,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!result || result.exitCode !== 0) return { files: [], truncated: false };
    const paths = result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
      .toSorted();
    const files = yield* Effect.promise(() =>
      Promise.all(
        paths.slice(0, IGNORED_FILES_LIMIT).map(async (relativePath) => {
          // lstat: a symlink usually points outside the workspace, where reads refuse to go.
          const stat = await NodeFSP.lstat(path.join(normalizedCwd, relativePath)).catch(
            () => null,
          );
          return stat?.isFile() ? { path: relativePath, byteLength: stat.size } : null;
        }),
      ),
    );
    return {
      files: files.filter((file) => file !== null),
      truncated: paths.length > IGNORED_FILES_LIMIT,
    };
  });

  return WorkspaceEntries.of({
    listRepositories,
    browse,
    list,
    listIgnoredFiles,
    refresh,
    search,
    searchContents,
  });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(WorkspaceRepositories.layer),
  Layer.provide(VcsProcess.layer),
);
