from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent


def _default_service_name() -> str:
    env_name = os.getenv("VBOT_SERVICE_NAME", "").strip()
    if env_name:
        return env_name
    return "webchat-local-lan"


def _which(cmd: str) -> Path | None:
    resolved = shutil.which(cmd)
    return Path(resolved) if resolved else None


def _detect_uv() -> Path | None:
    for candidate in ("uv", "uv.exe"):
        resolved = _which(candidate)
        if resolved is not None:
            return resolved
    return None


def _detect_python(project_dir: Path) -> Path:
    candidates = [
        project_dir / ".venv" / "bin" / "python",
        project_dir / ".venv" / "bin" / "python3",
        project_dir / ".venv" / "Scripts" / "python.exe",
        Path(sys.executable),
    ]
    for cmd in ("python3", "python"):
        resolved = _which(cmd)
        if resolved is not None:
            candidates.append(resolved)

    for candidate in candidates:
        try:
            if candidate.exists():
                return candidate
        except OSError:
            continue

    raise FileNotFoundError("Cannot find Python. Run setup script first (uv sync).")


def _build_exec_start(main_path: Path, prefer_uv: bool) -> tuple[str, str]:
    if not main_path.exists():
        raise FileNotFoundError(f"Missing entrypoint: {main_path}")

    if prefer_uv:
        uv_path = _detect_uv()
        if uv_path is None:
            raise FileNotFoundError(
                "uv not found in PATH. Run scripts/setup_linux.sh first (or set --no-prefer-uv)."
            )
        exec_path = f'"{uv_path}" run --project "{BASE_DIR}" --no-sync python -u "{main_path}"'
        return exec_path, "uv"

    python_path = _detect_python(BASE_DIR)
    exec_path = f'"{python_path}" -u "{main_path}"'
    return exec_path, "python"


def build_service_content(
    *,
    service_name: str,
    description: str,
    working_dir: str,
    user: str,
    group: str | None,
    exec_path: str,
) -> str:
    group_line = f"Group={group}\n" if group else ""
    return f"""[Unit]
Description={description}
After=network.target

[Service]
User={user}
{group_line}WorkingDirectory={working_dir}
ExecStart={exec_path}
EnvironmentFile=-{working_dir}/.env
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONUTF8=1
Environment=PYTHONIOENCODING=utf-8
StandardOutput=journal
StandardError=journal
Restart=always
RestartSec=3
TimeoutStopSec=30
KillMode=control-group
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
"""


def install_service(service_name: str, service_content: str) -> None:
    temp_service_file = BASE_DIR / f"{service_name}.service"
    temp_service_file.write_text(service_content, encoding="utf-8")

    destination = f"/etc/systemd/system/{service_name}.service"
    subprocess.run(["sudo", "mv", str(temp_service_file), destination], check=True)
    subprocess.run(["sudo", "systemctl", "daemon-reload"], check=True)
    subprocess.run(["sudo", "systemctl", "stop", service_name], check=False)
    subprocess.run(["sudo", "systemctl", "reset-failed", service_name], check=False)
    subprocess.run(["sudo", "systemctl", "enable", service_name], check=True)
    subprocess.run(["sudo", "systemctl", "start", service_name], check=True)
    print(f"Service {service_name} created, enabled and started.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate/install systemd service for this project.")
    parser.add_argument("--name", default=_default_service_name(), help="systemd service name")
    parser.add_argument("--description", default=BASE_DIR.name, help="systemd Description field")
    parser.add_argument("--user", default=os.getenv("VBOT_SERVICE_USER", "www-data"), help="Linux user")
    parser.add_argument("--group", default=os.getenv("VBOT_SERVICE_GROUP") or None, help="Linux group")
    parser.add_argument("--working-dir", default=str(BASE_DIR), help="WorkingDirectory")
    parser.add_argument("--no-prefer-uv", action="store_true", help="Use .venv/python instead of uv run")
    parser.add_argument("--print-only", action="store_true", help="Print generated service and exit")
    parser.add_argument("--check", action="store_true", help="Validate runtime command and exit")
    args = parser.parse_args(argv)

    prefer_uv = not args.no_prefer_uv
    main_path = BASE_DIR / "main.py"
    exec_path, runtime = _build_exec_start(main_path=main_path, prefer_uv=prefer_uv)

    if args.check:
        print(f"[check] runtime={runtime}")
        print(f"[check] exec={exec_path}")
        return 0

    content = build_service_content(
        service_name=args.name,
        description=args.description,
        working_dir=args.working_dir,
        user=args.user,
        group=args.group,
        exec_path=exec_path,
    )

    if args.print_only:
        print(content)
        return 0

    install_service(service_name=args.name, service_content=content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
