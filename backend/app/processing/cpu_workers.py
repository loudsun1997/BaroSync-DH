"""CPU worker count for parallel processing (upload / batch pipelines)."""

from __future__ import annotations

import os


def processing_worker_count() -> int:
    """
    Logical CPUs to use for ProcessPoolExecutor-style work.
    Override with BAROSYNC_PROCESSING_WORKERS (integer >= 1).
    """
    raw = os.environ.get("BAROSYNC_PROCESSING_WORKERS", "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    n = getattr(os, "process_cpu_count", None)
    if callable(n):
        c = n()
        if isinstance(c, int) and c > 0:
            return c
    return max(1, os.cpu_count() or 1)
