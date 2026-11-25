const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const { setMobileVersion } = require("./set-mobile-version.cjs");
const { RELEASE_PACKAGE_FILES, setReleaseVersion } = require("./set-release-version.cjs");

const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");

const recordScript = read("actions/record-build-tag/action.yml")
  .split(/^ {6}run: \|\n/m)[1]
  .replace(/^ {8}/gm, "")
  .replace(/^remote=.*$/m, 'remote="$TEST_REMOTE"');

function recordTag(commitOf, failedFetches = 0) {
  const directory = mkdtempSync(join(tmpdir(), "t3-record-tag-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const remote = join(directory, "remote.git");
    const work = join(directory, "work");
    git(directory, "init", "--quiet", "--bare", remote);
    git(directory, "init", "--quiet", "--initial-branch=main", work);
    const commit = (message) => {
      git(
        work,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
      );
      return git(work, "rev-parse", "HEAD");
    };
    const shas = { first: commit("first") };
    shas.head = commit("second");
    git(work, "push", "--quiet", remote, "main");
    git(work, "checkout", "--quiet", "--detach");
    shas.elsewhere = commit("not on main");
    git(work, "push", "--quiet", remote, "HEAD:refs/heads/other");
    git(work, "checkout", "--quiet", "main");
    // The first fetches fail, and the waits between attempts are skipped.
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\nif [ "$1" = fetch ] && [ "$(wc -l < "$FETCHES")" -lt "$FAILED_FETCHES" ]; then echo x >> "$FETCHES"; exit 1; fi\nexec "$REAL_GIT" "$@"\n`,
    );
    writeFileSync(join(bin, "sleep"), "#!/bin/bash\n");
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    writeFileSync(join(directory, "fetches"), "");
    const result = spawnSync("bash", ["-c", recordScript], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        REAL_GIT: execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
        FETCHES: join(directory, "fetches"),
        FAILED_FETCHES: String(failedFetches),
        HOME: directory,
        TEST_REMOTE: remote,
        GITHUB_REF: "refs/heads/main",
        TAG: "build/1",
        MESSAGE: "",
        REPLACE: "false",
        COMMIT: commitOf(shas),
      },
    });
    const tagged = git(directory, "ls-remote", remote, "refs/tags/build/1").split(/\s/)[0];
    return { status: result.status, tagged, shas };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the build record tags the named commit only when it is on the workflow's ref", () => {
  const onRef = recordTag((shas) => shas.first);
  assert.deepEqual([onRef.status, onRef.tagged], [0, onRef.shas.first]);
  const retried = recordTag((shas) => shas.first, 2);
  assert.deepEqual([retried.status, retried.tagged], [0, retried.shas.first]);
  assert.equal(recordTag((shas) => shas.first, 3).status, 1);
  const head = recordTag(() => "");
  assert.deepEqual([head.status, head.tagged], [0, head.shas.head]);
  for (const commitOf of [(shas) => shas.elsewhere, () => "main", () => "0".repeat(40)]) {
    const refused = recordTag(commitOf);
    assert.deepEqual([refused.status, refused.tagged], [1, ""]);
  }
});

test("the Vite+ toolchain is cached before the job installs or runs project code", () => {
  const names = Array.from(
    read("actions/setup-ci-deps/action.yml").matchAll(
      /^ {4}- name: (.+)\n(?: {6}.*\n)*? {6}uses: (\S+)|^ {4}- name: (.+)$/gm,
    ),
    (match) => ({ name: match[1] ?? match[3], uses: match[2] ?? "" }),
  );
  const index = (name) => names.findIndex((step) => step.name === name);
  assert.match(names[index("Restore Vite+")].uses, /^actions\/cache\/restore@/);
  assert.match(names[index("Save Vite+")].uses, /^actions\/cache\/save@/);
  assert.ok(index("Save Vite+") < index("Resolve pnpm store"));
  assert.ok(index("Save Vite+") < index("Install dependencies"));
  // The combined action saves at the end of the job, after everything ran.
  assert.ok(names.every((step) => !step.uses.startsWith("actions/cache@")));
});

test("a version override rewrites only the app version", () => {
  const config = read("../apps/mobile/app.config.ts");
  const next = setMobileVersion(config, "9.8.7");
  assert.match(next, /^ {2}version: repoEnv\.T3CODE_MOBILE_VERSION \?\? "9\.8\.7",$/m);
  assert.equal(setMobileVersion(next, "9.8.7"), next);
  assert.deepEqual(
    next.split("\n").filter((line, index) => line !== config.split("\n")[index]).length,
    1,
  );
  for (const version of ["", "1", "1.2.3.4", "1.2-beta", '1.2", extra: "x']) {
    assert.throws(() => setMobileVersion(config, version), /two or three dot-separated integers/);
  }
  assert.throws(() => setMobileVersion("export default {};", "1.2.3"), /Could not update/);
});

test("a release version bump rewrites only the version of each release manifest", () => {
  const listed = /releasePackageFiles = \[\n([^\]]+)\]/.exec(
    read("../scripts/lib/tagged-source-version.ts"),
  )[1];
  assert.deepEqual(
    RELEASE_PACKAGE_FILES,
    Array.from(listed.matchAll(/"([^"]+)"/g), (m) => m[1]),
  );
  for (const file of RELEASE_PACKAGE_FILES) {
    const manifest = read(`../${file}`);
    const next = setReleaseVersion(manifest, "98.7.6");
    assert.equal(JSON.parse(next).version, "98.7.6");
    assert.deepEqual(
      { ...JSON.parse(next), version: "" },
      { ...JSON.parse(manifest), version: "" },
    );
    assert.equal(setReleaseVersion(next, "98.7.6"), next);
    assert.deepEqual(
      next.split("\n").filter((line, index) => line !== manifest.split("\n")[index]).length,
      1,
    );
  }
  for (const version of ["", "1", "1.2", "v1.2.3", '1.2.3", "x": "y']) {
    assert.throws(() => setReleaseVersion('{\n  "version": "1.0.0"\n}\n', version), /Invalid/);
  }
  assert.equal(
    setReleaseVersion('{\n  "version": "1.0.0"\n}\n', "1.2.3-rc.1"),
    '{\n  "version": "1.2.3-rc.1"\n}\n',
  );
  assert.throws(() => setReleaseVersion('{\n  "name": "x"\n}\n', "1.2.3"), /exactly one/);
});
