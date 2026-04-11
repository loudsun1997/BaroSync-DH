"""Attach a rotating file log for the API process (uvicorn + app.*)."""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path


def attach_file_logging(
    *,
    repo_root: Path,
    log_path: Path | None = None,
    max_bytes: int = 5 * 1024 * 1024,
    backup_count: int = 3,
) -> Path:
    """
    Append a RotatingFileHandler to uvicorn and app loggers.
    Safe to call on uvicorn --reload re-imports (skips if same file already attached).
    """
    env_file = os.environ.get("BAROSYNC_LOG_PATH", "").strip()
    if log_path is not None:
        path = log_path
    elif env_file:
        path = Path(env_file).expanduser()
    else:
        raw_dir = os.environ.get("BAROSYNC_LOG_DIR", str(repo_root / "logs")).strip()
        log_dir = Path(raw_dir).expanduser()
        if not log_dir.is_absolute():
            log_dir = (Path.cwd() / log_dir).resolve()
        path = log_dir / "backend.log"
    path = path.resolve()
    # BAROSYNC_LOG_PATH may mistakenly point at a directory (e.g. "." while cwd is backend/).
    if path.is_dir():
        path = path / "backend.log"
        path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(pathname)s:%(lineno)d | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler = RotatingFileHandler(
        path,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    handler.setFormatter(fmt)
    target = str(path)

    def _needs_handler(logger: logging.Logger) -> bool:
        for h in logger.handlers:
            if isinstance(h, RotatingFileHandler):
                try:
                    if getattr(h, "baseFilename", None) == target:
                        return False
                except Exception:
                    pass
        return True

    # Do not attach to parent "uvicorn" and children both — records propagate and would double-log.
    for name in ("uvicorn.error", "uvicorn.access", "app"):
        log = logging.getLogger(name)
        if _needs_handler(log):
            log.addHandler(handler)
            log.setLevel(logging.INFO)

    return path
