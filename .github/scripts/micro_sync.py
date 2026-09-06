"""Merge an upstream release while preserving this fork's workflow directory."""

import argparse
from pathlib import Path
import subprocess


def git(root, *args, check=True):
    result = subprocess.run(
        ["git", *args], cwd=root, text=True, capture_output=True
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result


def merge_release(root: Path, reference: str) -> bool:
    if git(root, "status", "--porcelain").stdout:
        raise RuntimeError("Refusing to sync a dirty checkout.")
    upstream = git(root, "rev-parse", "--verify", reference + "^{commit}").stdout.strip()
    included = git(root, "merge-base", "--is-ancestor", upstream, "HEAD", check=False)
    if included.returncode == 0:
        return False
    if included.returncode != 1:
        raise RuntimeError(included.stderr)
    result = git(root, "merge", "--no-commit", "--no-ff", upstream, check=False)
    conflicts = git(root, "diff", "--name-only", "--diff-filter=U", "-z").stdout.split("\0")
    source_conflicts = [p for p in conflicts if p and not p.startswith(".github/workflows/")]
    if source_conflicts or (result.returncode != 0 and not any(conflicts)):
        git(root, "merge", "--abort", check=False)
        raise RuntimeError("Upstream merge needs attention: " + (", ".join(source_conflicts) or result.stderr))
    try:
        # Upstream uses private runners and production deployment credentials.
        # Keeping this tree unchanged also permits pushes with GITHUB_TOKEN,
        # which cannot grant itself permission to edit workflow files.
        git(root, "rm", "-rf", "--ignore-unmatch", "--", ".github/workflows")
        git(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", ".github/workflows")
        git(root, "-c", "core.hooksPath=/dev/null", "commit", "-m", f"chore: merge upstream release {reference}")
    except Exception:
        git(root, "merge", "--abort", check=False)
        raise
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference")
    args = parser.parse_args()
    changed = merge_release(Path.cwd(), args.reference)
    print("Merged upstream release." if changed else "Latest upstream release is already included.")
    import os

    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as handle:
            handle.write(f"changed={str(changed).lower()}\n")
