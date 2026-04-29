"""In-memory upload job queue with processing progress (single-process dev server)."""

from __future__ import annotations

import logging
import threading
import time
import uuid
import zipfile
from typing import Any

from app.db import (
    find_existing_session_for_hashes,
    get_session_result,
    persist_upload_result,
    upload_file_hashes,
)
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
    trail_id: str | None = None,
) -> None:
    def progress(step: str, pct: int) -> None:
        _update(job_id, status="running", step=step, progress=pct)

    try:
        progress("Starting…", 0)
        uploaded_files: list[dict[str, Any]] = [
            {
                "bytes": data,
                "stem": stem,
                "filename": f"{stem}.zip",
                "content_type": "application/zip",
            }
            for data, stem in multi_pairs
        ]
        if not uploaded_files and single_bytes is not None:
            stem = single_stem or "upload"
            uploaded_files.append(
                {
                    "bytes": single_bytes,
                    "stem": stem,
                    "filename": f"{stem}.zip",
                    "content_type": "application/zip",
                }
            )
        hashes = upload_file_hashes(uploaded_files)
        existing_session_id = find_existing_session_for_hashes(hashes, trail_id=trail_id)
        if existing_session_id:
            existing_result = get_session_result(existing_session_id)
            if isinstance(existing_result, dict):
                existing_result["database"] = {
                    "trail_id": trail_id,
                    "session_id": existing_session_id,
                    "duplicate_upload": True,
                    "reused_existing_session": True,
                }
                _update(job_id, status="done", step="Duplicate upload reused", progress=100, result=existing_result)
                _log.info(
                    "Upload job reused existing session job_id=%s session_id=%s",
                    job_id,
                    existing_session_id,
                )
                return

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
        source_names = [stem for _, stem in multi_pairs]
        if not source_names and single_stem:
            source_names = [single_stem]
        if isinstance(result, dict):
            persisted = persist_upload_result(
                result,
                trail_id=trail_id,
                source_names=source_names,
                uploaded_files=uploaded_files,
            )
            result["database"] = {
                "trail_id": trail_id,
                **persisted,
            }
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
