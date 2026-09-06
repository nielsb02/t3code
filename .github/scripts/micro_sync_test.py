from pathlib import Path
import tempfile
import unittest

from micro_sync import git, merge_release


class SyncTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
