"""Merge an upstream release while preserving this fork's workflow directory."""

import argparse
from pathlib import Path
import re
import subprocess

# Stable releases and nightlies are cut from upstream main. Previews are not,
# so merging one would bring commits that a later stable release lacks.
UPSTREAM_TAG = re.compile(r"^v(\d+\.\d+\.\d+)(?:-nightly\.\d{8}\.\d+)?$")
MIGRATIONS = "apps/server/src/persistence/Migrations"
MANIFEST_ENTRY = re.compile(r'^\s*\[(\d+), "(\w+)", ', re.MULTILINE)


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


def release_version(tag: str, run_number: int) -> str:
    """Desktop version for a build that includes `tag`.

    Nightly and stable builds of one upstream version share the same base, so
    the monotonic run number orders them for the updater. Keeping the upstream
    channel out of the prerelease avoids `-micro` sorting below `-nightly`.
    """
    match = UPSTREAM_TAG.match(tag)
    if not match:
        raise ValueError(f"Unsupported upstream tag {tag!r}; use vX.Y.Z or vX.Y.Z-nightly.YYYYMMDD.N.")
    return f"{match.group(1)}-micro.{run_number}"


def migration_drift(root: Path, upstream: str) -> list[str]:
    """Differences between this fork's migrations and upstream's at `upstream`.

    The migrator keys on ids only, so any fork migration masks a future upstream
    migration with the same id. Fork schema changes must not use this ledger.
    """
    def manifest(ref):
        source = git(root, "show", f"{ref}:apps/server/src/persistence/Migrations.ts").stdout
        return MANIFEST_ENTRY.findall(source)

    drift = [f"manifest entry {i}_{n}" for i, n in sorted(set(manifest("HEAD")) ^ set(manifest(upstream)))]
    files = git(root, "diff", "--name-only", upstream, "HEAD", "--", MIGRATIONS).stdout.split()
    return drift + [f"file {path}" for path in files]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("merge").add_argument("reference")
    version = commands.add_parser("version")
    version.add_argument("tag")
    version.add_argument("run_number", type=int)
    commands.add_parser("check-migrations").add_argument("reference")
    args = parser.parse_args()

    if args.command == "version":
        print(release_version(args.tag, args.run_number))
    elif args.command == "check-migrations":
        if drift := migration_drift(Path.cwd(), args.reference):
            raise SystemExit("Fork migrations diverge from upstream:\n" + "\n".join(drift))
        print("Migrations match upstream.")
    else:
        changed = merge_release(Path.cwd(), args.reference)
        print("Merged upstream release." if changed else "Latest upstream release is already included.")
        import os

        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a") as handle:
                handle.write(f"changed={str(changed).lower()}\n")
