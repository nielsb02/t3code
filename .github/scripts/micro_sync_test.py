from pathlib import Path
import tempfile
import unittest

from micro_sync import fork_tests, git, merge_release, migration_drift, release_version


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="t3-micro-sync-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        git(self.root, "init", "-b", "main")
        git(self.root, "config", "user.name", "Sync fixture")
        git(self.root, "config", "user.email", "fixture@example.invalid")
        self.write("opening.txt", "base opening\n")
        self.write("feature.txt", "base feature\n")
        self.write(".github/workflows/upstream.yml", "private-runner\n")
        self.commit("base")
        git(self.root, "branch", "upstream")
        self.write("opening.txt", "custom opening\n")
        (self.root / ".github/workflows/upstream.yml").unlink()
        self.write(".github/workflows/micro.yml", "our runner\n")
        self.commit("fork")

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, message):
        git(self.root, "add", "-A")
        git(self.root, "commit", "-m", message)


class SyncTests(GitFixture):
    def test_merges_source_preserving_patch_and_workflows(self):
        git(self.root, "checkout", "upstream")
        self.write("feature.txt", "new upstream feature\n")
        self.write(".github/workflows/upstream.yml", "changed private runner\n")
        self.write(".github/workflows/new.yml", "new deployment\n")
        self.commit("new release")
        git(self.root, "checkout", "main")
        before = git(self.root, "rev-parse", "HEAD").stdout.strip()
        self.assertTrue(merge_release(self.root, "upstream"))
        self.assertEqual((self.root / "opening.txt").read_text(), "custom opening\n")
        self.assertEqual((self.root / "feature.txt").read_text(), "new upstream feature\n")
        self.assertEqual(git(self.root, "diff", before, "HEAD", "--", ".github/workflows").stdout, "")
        self.assertEqual(git(self.root, "status", "--porcelain").stdout, "")
        self.assertFalse(merge_release(self.root, "upstream"))

    def test_source_conflicts_abort_without_changing_fork(self):
        git(self.root, "checkout", "upstream")
        self.write("opening.txt", "conflicting upstream opening\n")
        self.commit("conflict")
        git(self.root, "checkout", "main")
        before = git(self.root, "rev-parse", "HEAD").stdout
        with self.assertRaisesRegex(RuntimeError, "opening.txt"):
            merge_release(self.root, "upstream")
        self.assertEqual(git(self.root, "rev-parse", "HEAD").stdout, before)
        self.assertEqual(git(self.root, "status", "--porcelain").stdout, "")
        self.assertEqual((self.root / "opening.txt").read_text(), "custom opening\n")

    def test_dirty_checkout_is_preserved(self):
        self.write("feature.txt", "uncommitted user edit\n")
        with self.assertRaisesRegex(RuntimeError, "dirty"):
            merge_release(self.root, "upstream")
        self.assertEqual((self.root / "feature.txt").read_text(), "uncommitted user edit\n")


class ReleaseVersionTests(unittest.TestCase):
    def test_stable_and_nightly_share_a_base_ordered_by_run(self):
        self.assertEqual(release_version("v0.0.46-nightly.20261009.2873", 61), "0.0.46-micro.61")
        self.assertEqual(release_version("v0.0.46", 70), "0.0.46-micro.70")

    def test_rejects_previews_and_other_refs(self):
        for tag in ("v0.0.46-preview.20261009.2851", "main", "0.0.46", "v0.0.46-nightly"):
            with self.assertRaises(ValueError):
                release_version(tag, 1)


class MigrationDriftTests(GitFixture):
    MANIFEST = "apps/server/src/persistence/Migrations.ts"

    def manifest(self, *entries):
        lines = "".join(f'  [{i}, "{name}", Migration{i}],\n' for i, name in entries)
        self.write(self.MANIFEST, f"export const migrationEntries = [\n{lines}];\n")

    def test_reports_fork_migrations(self):
        self.manifest((1, "Init"))
        self.write("apps/server/src/persistence/Migrations/001_Init.ts", "init\n")
        self.commit("upstream migrations")
        git(self.root, "branch", "-f", "upstream")
        self.assertEqual(migration_drift(self.root, "upstream"), [])
        self.manifest((1, "Init"), (2, "ForkOnly"))
        self.write("apps/server/src/persistence/Migrations/002_ForkOnly.ts", "fork\n")
        self.commit("fork migration")
        self.assertEqual(
            migration_drift(self.root, "upstream"),
            [
                "manifest entry 2_ForkOnly",
                "file apps/server/src/persistence/Migrations/002_ForkOnly.ts",
            ],
        )


class ForkTestsTests(GitFixture):
    def test_lists_changed_tests_and_tests_beside_changed_sources(self):
        for path in ("apps/web/a.ts", "apps/web/a.test.ts", "apps/web/b.tsx", "apps/web/b.test.tsx",
                     "apps/web/c.ts", "apps/web/c.test.ts", "apps/web/d.browser.test.ts"):
            self.write(path, "upstream\n")
        self.commit("upstream sources")
        git(self.root, "branch", "-f", "upstream")
        self.write("apps/web/a.ts", "fork\n")
        self.write("apps/web/b.test.tsx", "fork\n")
        self.write("apps/web/d.browser.test.ts", "fork\n")
        self.write("apps/web/new.integration.test.ts", "fork\n")
        self.write("apps/web/untested.ts", "fork\n")
        (self.root / "apps/web/c.test.ts").unlink()
        self.commit("fork changes")
        self.assertEqual(
            fork_tests(self.root, "upstream"),
            ["apps/web/a.test.ts", "apps/web/b.test.tsx", "apps/web/new.integration.test.ts"],
        )


if __name__ == "__main__":
    unittest.main()
