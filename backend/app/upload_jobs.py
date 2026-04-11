"""In-memory upload job queue with processing progress (single-process dev server)."""

from __future__ import annotations

import logging
import threading
import time
import uuid
import zipfile
from typing import Any

from app.processing.pipeline import process_multi_zip_bytes, process_zip_bytes

_log = logging.getLogger(__name__)

_MAX_JOBS = 200
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _prune_locked() -> None:
    if len(_jobs) <= _MAX_JOBS:
        return
    oldest_id = min(_jobs.items(), key=lambda kv: float(kv[1]["created"]))[0]
    del _jobs[oldest_id]


def create_job() -> str:
    job_id = uuid.uuid4().hex
    with _lock:
        _prune_locked()
        _jobs[job_id] = {
            "status": "pending",
            "progress": 0,
            "step": "Queued…",
            "result": None,
            "error": None,
            "created": time.time(),
        }
    return job_id


def get_job_public(job_id: str) -> dict[str, Any] | None:
    with _lock:
        row = _jobs.get(job_id)
        if not row:
            return None
        out: dict[str, Any] = {
            "status": row["status"],
            "progress": int(row["progress"]),
            "step": str(row["step"]),
        }
        if row["status"] == "done" and row.get("result") is not None:
            out["result"] = row["result"]
        if row["status"] == "error":
            out["error"] = row.get("error") or "Unknown error"
        return out


def _update(job_id: str, **kwargs: Any) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)


def run_upload_job(
    job_id: str,
    multi_pairs: list[tuple[bytes, str]],
    single_bytes: bytes | None,
    single_stem: str | None,
) -> None:
    def progress(step: str, pct: int) -> None:
        _update(job_id, status="running", step=step, progress=pct)

    try:
        progress("Starting…", 0)
        if multi_pairs:
            if len(multi_pairs) == 1:
                result = process_zip_bytes(
                    multi_pairs[0][0],
                    source_stem=multi_pairs[0][1],
                    progress=progress,
                )
            else:
                result = process_multi_zip_bytes(multi_pairs, progress=progress)
        elif single_bytes is not None:
            result = process_zip_bytes(single_bytes, source_stem=single_stem, progress=progress)
        else:
            raise ValueError("No upload payload")
        _update(job_id, status="done", step="Complete", progress=100, result=result)
        _log.info(
            "Upload job OK job_id=%s run_count=%s",
            job_id,
            result.get("run_count") if isinstance(result, dict) else "?",
        )
    except ValueError as e:
        _log.warning("Upload job validation failed: %s", e)
        _update(job_id, status="error", step="Failed", progress=0, error=str(e))
    except zipfile.BadZipFile:
        _log.warning("Upload job: invalid ZIP archive")
        _update(job_id, status="error", step="Invalid ZIP", progress=0, error="Invalid ZIP archive")
    except Exception:
        _log.exception("Upload job failed")
        _update(
            job_id,
            status="error",
            step="Failed",
            progress=0,
            error="Internal error while processing upload",
        )
