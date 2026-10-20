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
TEST_FILE = re.compile(r"\.test\.tsx?$")
SOURCE_FILE = re.compile(r"^(?:apps|packages|scripts)/.*(?<!\.d)\.tsx?$")
# Mobile renders these through jsdom in its own "react" Vitest project; the root runner uses Node.
MOBILE_CONFIG = "apps/mobile/vite.config.ts"
MOBILE_REACT_TEST = re.compile(r'^\s*"(src/[^"]+\.test\.tsx)",?$', re.MULTILINE)


def git(root, *args, check=True):
    result = subprocess.run(
        ["git", *args], cwd=root, text=True, capture_output=True
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result


def merge_release(root: Path, reference: str, name: str | None = None) -> bool:
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
        git(root, "-c", "core.hooksPath=/dev/null", "commit", "-m", f"chore: merge upstream release {name or reference}")
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


def mobile_react_tests(root: Path) -> set[str]:
    config = root / MOBILE_CONFIG
    if not config.is_file():
        return set()
    return {f"apps/mobile/{path}" for path in MOBILE_REACT_TEST.findall(config.read_text())}


def fork_tests(root: Path, upstream: str, mobile_react: bool = False) -> list[str]:
    """Tests the fork adds or changes, and the tests beside sources it changes.

    Browser tests need a separate runner, so they are left out. Mobile's React
    tests are listed separately, relative to apps/mobile, for its jsdom project.
    """
    changed = git(root, "diff", "--name-only", "--diff-filter=d", upstream, "HEAD").stdout.split()
    candidates = set()
    for path in changed:
        if TEST_FILE.search(path):
            candidates.add(path)
        elif SOURCE_FILE.match(path):
            stem = path.rsplit(".", 1)[0]
            candidates.update({f"{stem}.test.ts", f"{stem}.test.tsx"})
    tests = sorted(p for p in candidates if ".browser.test." not in p and (root / p).is_file())
    react = mobile_react_tests(root)
    if mobile_react:
        return [p.removeprefix("apps/mobile/") for p in tests if p in react]
    return [p for p in tests if p not in react]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    merge = commands.add_parser("merge")
    merge.add_argument("reference")
    merge.add_argument("--name", help="Upstream tag named in the merge commit")
    version = commands.add_parser("version")
    version.add_argument("tag")
    version.add_argument("run_number", type=int)
    commands.add_parser("check-migrations").add_argument("reference")
    tests = commands.add_parser("fork-tests")
    tests.add_argument("reference")
    tests.add_argument("--mobile-react", action="store_true", help="List apps/mobile's jsdom tests instead")
    args = parser.parse_args()

    if args.command == "version":
        print(release_version(args.tag, args.run_number))
    elif args.command == "check-migrations":
        if drift := migration_drift(Path.cwd(), args.reference):
            raise SystemExit("Fork migrations diverge from upstream:\n" + "\n".join(drift))
        print("Migrations match upstream.")
    elif args.command == "fork-tests":
        print("\n".join(fork_tests(Path.cwd(), args.reference, args.mobile_react)))
    else:
        changed = merge_release(Path.cwd(), args.reference, args.name)
        print("Merged upstream release." if changed else "Latest upstream release is already included.")
        import os

        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a") as handle:
                handle.write(f"changed={str(changed).lower()}\n")
