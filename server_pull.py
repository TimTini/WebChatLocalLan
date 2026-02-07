from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import stat


DEFAULT_SERVER_BASE = r"Z:\home\vlinux\Desktop"
_TIME_SKEW_SECONDS = 2.0


@dataclass(frozen=True)
class SyncAction:
    rel_path: PurePosixPath
    direction: str  # "local->server" | "server->local" | "skip"
    reason: str


def _run(cmd: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(cwd), text=True, check=False, capture_output=True)


def _git_pull(repo_dir: Path) -> None:
    proc = _run(["git", "pull"], cwd=repo_dir)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        raise RuntimeError(f"git pull failed (exit={proc.returncode}) in {repo_dir}")


def _git_check_ignored(repo_dir: Path, rel_path: PurePosixPath) -> bool:
    proc = _run(["git", "check-ignore", "-q", "--", rel_path.as_posix()], cwd=repo_dir)
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    raise RuntimeError(f"git check-ignore failed (exit={proc.returncode}): {proc.stderr.strip()}")


def _is_allowed_ignored_file(rel_path: PurePosixPath) -> bool:
    # Dot-folders: ignore everything inside.
    if any(part.startswith(".") for part in rel_path.parts[:-1]):
        return False
    # Dot-files: only sync ".env".
    name = rel_path.name
    if name.startswith(".") and name != ".env":
        return False
    return True


def _copy2(src: Path, dst: Path, *, dry_run: bool) -> None:
    if dry_run:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        _ensure_writable(dst)

    tmp = dst.with_name(f"{dst.name}.tmp")
    try:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass

        shutil.copy2(src, tmp)
        try:
            tmp.replace(dst)
        except PermissionError:
            _ensure_writable(dst)
            try:
                tmp.replace(dst)
            except PermissionError as exc:
                raise PermissionError(
                    f"Permission denied writing {dst}. Close any editor or stop any process using it."
                ) from exc
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass


def _ensure_writable(path: Path) -> None:
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        return
    try:
        path.chmod(mode | stat.S_IWRITE)
    except Exception:
        pass


def _sync_one_file(
    *,
    rel_path: PurePosixPath,
    local_root: Path,
    server_root: Path,
    dry_run: bool,
) -> SyncAction | None:
    local_path = local_root.joinpath(*rel_path.parts)
    server_path = server_root.joinpath(*rel_path.parts)

    local_is_file = local_path.is_file()
    server_is_file = server_path.is_file()
    if not local_is_file and not server_is_file:
        return None

    if local_is_file and server_is_file:
        local_mtime = float(local_path.stat().st_mtime)
        server_mtime = float(server_path.stat().st_mtime)
        if local_mtime > server_mtime + _TIME_SKEW_SECONDS:
            try:
                _copy2(local_path, server_path, dry_run=dry_run)
            except PermissionError:
                return SyncAction(rel_path=rel_path, direction="skip", reason="permission denied")
            return SyncAction(rel_path=rel_path, direction="local->server", reason="local newer")
        if server_mtime > local_mtime + _TIME_SKEW_SECONDS:
            try:
                _copy2(server_path, local_path, dry_run=dry_run)
            except PermissionError:
                return SyncAction(rel_path=rel_path, direction="skip", reason="permission denied")
            return SyncAction(rel_path=rel_path, direction="server->local", reason="server newer")
        return SyncAction(rel_path=rel_path, direction="skip", reason="same mtime")

    if local_is_file:
        try:
            _copy2(local_path, server_path, dry_run=dry_run)
        except PermissionError:
            return SyncAction(rel_path=rel_path, direction="skip", reason="permission denied")
        return SyncAction(rel_path=rel_path, direction="local->server", reason="server missing")

    try:
        _copy2(server_path, local_path, dry_run=dry_run)
    except PermissionError:
        return SyncAction(rel_path=rel_path, direction="skip", reason="permission denied")
    return SyncAction(rel_path=rel_path, direction="server->local", reason="local missing")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pull server repo + sync selected gitignored files.")
    parser.add_argument(
        "--server-base",
        default=DEFAULT_SERVER_BASE,
        help=f"Base path that contains the server repo folder (default: {DEFAULT_SERVER_BASE})",
    )
    parser.add_argument(
        "--folder",
        default=None,
        help="Server repo folder name (default: local folder name)",
    )
    parser.add_argument("--no-pull", action="store_true", help="Skip 'git pull' on server repo")
    parser.add_argument("--no-sync-ignored", action="store_true", help="Skip syncing ignored files")
    parser.add_argument("--dry-run", action="store_true", help="Print actions but do not copy files")
    args = parser.parse_args(argv)

    local_root = Path(__file__).resolve().parent
    folder_name = args.folder or local_root.name
    server_root = Path(args.server_base).joinpath(folder_name)

    if not server_root.exists():
        sys.stderr.write(f"ERROR: Server path not found: {server_root}\n")
        return 1

    if not args.no_pull:
        print(f"[server] git pull: {server_root}")
        _git_pull(server_root)

    if args.no_sync_ignored:
        return 0

    # We only sync ignored files at repo root to avoid copying large ignored folders (e.g. data/).
    local_root_files = {p.name for p in local_root.iterdir() if p.is_file()}
    server_root_files = {p.name for p in server_root.iterdir() if p.is_file()}
    candidates = sorted(local_root_files | server_root_files)

    actions: list[SyncAction] = []
    for name in candidates:
        rel = PurePosixPath(name)
        if not _is_allowed_ignored_file(rel):
            continue
        if not _git_check_ignored(local_root, rel):
            continue
        act = _sync_one_file(rel_path=rel, local_root=local_root, server_root=server_root, dry_run=bool(args.dry_run))
        if act is not None:
            actions.append(act)

    if actions:
        print("\n[sync] gitignored root files:")
        for act in actions:
            print(f"- {act.direction:12} {act.rel_path.as_posix()} ({act.reason})")
    else:
        print("\n[sync] No gitignored root files to sync.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
