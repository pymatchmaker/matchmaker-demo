"""
Cross-platform Audiveris launcher (drop-in helper for matchmaker-demo).

Previously `utils.py` hardcoded /Applications/Audiveris.app/... which only
works on macOS. This module resolves Audiveris in the following order, so
Linux and Windows installs work out of the box:

  1. $AUDIVERIS_CMD            — explicit command / absolute path
  2. $AUDIVERIS_HOME           — extracted distribution dir
                                 (expects `bin/Audiveris[.bat]` or a `lib/` with JARs)
  3. `audiveris` / `Audiveris` on PATH
  4. Legacy macOS app bundle   — /Applications/Audiveris.app (the old behavior)
  5. Common Linux install dirs — /opt/audiveris, ~/opt/audiveris, ...

The result is cached per-process.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)


class AudiverisNotFound(RuntimeError):
    pass


def _from_env_cmd() -> list[str] | None:
    cmd = os.environ.get("AUDIVERIS_CMD")
    if not cmd:
        return None
    parts = cmd.split()
    if not parts:
        return None
    if not shutil.which(parts[0]) and not Path(parts[0]).exists():
        log.warning("AUDIVERIS_CMD=%s does not resolve to an executable", cmd)
        return None
    return parts


def _cmd_from_home(home: Path) -> list[str] | None:
    if not home.is_dir():
        return None
    for name in ("bin/Audiveris", "bin/audiveris", "bin/Audiveris.bat"):
        launcher = home / name
        if launcher.exists():
            return [str(launcher)]
    jars: list[str] = []
    for d in (home / "lib", home / "app"):
        if d.is_dir():
            jars.extend(str(p) for p in sorted(d.glob("*.jar")))
    if jars:
        java = os.environ.get("JAVA") or shutil.which("java") or "java"
        return [java, "-cp", os.pathsep.join(jars), "Audiveris"]
    return None


def _from_env_home() -> list[str] | None:
    home = os.environ.get("AUDIVERIS_HOME")
    return _cmd_from_home(Path(home)) if home else None


def _from_path() -> list[str] | None:
    for name in ("audiveris", "Audiveris"):
        found = shutil.which(name)
        if found:
            return [found]
    return None


def _from_macos_bundle() -> list[str] | None:
    bundle = Path("/Applications/Audiveris.app")
    if not bundle.is_dir():
        return None
    java = bundle / "Contents/runtime/Contents/Home/bin/java"
    app_dir = bundle / "Contents/app"
    if not java.exists() or not app_dir.is_dir():
        return None
    jars = sorted(app_dir.glob("*.jar"))
    if not jars:
        return None
    classpath = os.pathsep.join(str(p) for p in jars)
    return [str(java), "-cp", classpath, "Audiveris"]


def _from_common_dirs() -> list[str] | None:
    for home in [
        Path("/opt/audiveris"),
        Path("/opt/Audiveris"),
        Path.home() / "opt" / "audiveris",
        Path.home() / "opt" / "Audiveris",
    ]:
        cmd = _cmd_from_home(home)
        if cmd:
            return cmd
    return None


@lru_cache(maxsize=1)
def resolve_command() -> list[str]:
    for fn in (_from_env_cmd, _from_env_home, _from_path, _from_macos_bundle, _from_common_dirs):
        cmd = fn()
        if cmd:
            log.info("Audiveris launcher resolved via %s: %s", fn.__name__, cmd)
            return cmd
    raise AudiverisNotFound(
        "Could not locate Audiveris. Set AUDIVERIS_HOME to the extracted "
        "distribution directory, set AUDIVERIS_CMD to an executable, "
        "put `audiveris` on PATH, or install it to /opt/audiveris."
    )


def run_audiveris(
    pdf_path: Path,
    output_dir: Path,
    timeout: float = 600.0,
) -> subprocess.CompletedProcess:
    """Run Audiveris in batch/transcribe/export mode on a PDF."""
    cmd = [
        *resolve_command(),
        "-batch",
        "-transcribe",
        "-export",
        "-output",
        str(output_dir),
        "--",
        str(pdf_path),
    ]
    log.info("Invoking Audiveris: %s", " ".join(cmd))
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
