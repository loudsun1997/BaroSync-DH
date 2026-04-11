#!/usr/bin/env python3
"""Run the telemetry pipeline on a Sensor Logger export folder and print a short summary."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.processing.pipeline import process_directory  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: PYTHONPATH=backend python scripts/process_folder.py /path/to/export_folder")
        sys.exit(1)
    folder = Path(sys.argv[1]).expanduser().resolve()
    out = process_directory(folder)
    run = out["runs"][0] if out.get("runs") else {}
    tel = run.get("telemetry") or []
    sample = tel[0] if tel else {}
    print(json.dumps({"run_count": out.get("run_count"), "points": len(tel), "sample_keys": sorted(sample.keys())}, indent=2))


if __name__ == "__main__":
    main()
