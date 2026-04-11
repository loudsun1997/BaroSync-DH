from __future__ import annotations

import asyncio
import logging
import zipfile
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.processing.baro_align import (
    align_runs_at_gate_baro,
    build_comparison_payload,
    preview_gate_snap,
    telemetry_records_to_dataframe,
    telemetry_records_to_dataframe_preview,
)
from app.processing.pipeline import (
    RUN_COLORS,
    ordinal_run_label,
    process_directory,
    run_dict_from_proc,
    save_calculated_session_exports,
)
from app.logging_setup import attach_file_logging
from app.upload_jobs import create_job, get_job_public, run_upload_job

app = FastAPI(title="BaroSync DH Telemetry Lab", version="0.1.0")

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DATA_ROOT = _REPO_ROOT / "data"

_log_path = attach_file_logging(repo_root=_REPO_ROOT)
logger = logging.getLogger(__name__)
logger.info("BaroSync backend started; file log at %s", _log_path)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_unhandled_exceptions(request: Request, call_next):
    try:
        return await call_next(request)
    except HTTPException:
        raise
    except RequestValidationError:
        raise
    except Exception:
        logger.exception("%s %s — unhandled (traceback below)", request.method, request.url.path)
        raise


class AlignBaroRequest(BaseModel):
    gate_latitude: float
    gate_longitude: float
    gate_radius_m: float = Field(default=20.0, ge=1.0, le=500.0)
    vz_edge_eps: float = Field(default=0.03, ge=0.0, le=1.0)
    correlation_max_distance_m: float = Field(
        default=100.0,
        ge=10.0,
        le=2000.0,
        description="Baro sync uses Vz only within this distance (m) from the gate on Run A",
    )
    run_a_label: str | None = Field(default=None, max_length=300)
    run_b_label: str | None = Field(default=None, max_length=300)
    run_a_source_name: str | None = Field(default=None, max_length=500)
    run_b_source_name: str | None = Field(default=None, max_length=500)
    run_a_telemetry: Any  # row records or column-oriented dict (from pipeline JSON)
    run_b_telemetry: Any


class PreviewGateRequest(BaseModel):
    gate_latitude: float
    gate_longitude: float
    gate_radius_m: float = Field(default=20.0, ge=1.0, le=500.0)
    gate_half_width_m: float = Field(default=12.0, ge=2.0, le=80.0)
    run_a_telemetry: Any
    run_b_telemetry: Any


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/upload/status/{job_id}")
def upload_status(job_id: str):
    row = get_job_public(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown job_id")
    return row


@app.post("/upload")
async def upload(
    background_tasks: BackgroundTasks,
    zip_file: UploadFile | None = File(None, description="Single ZIP (legacy field name)"),
    files: list[UploadFile] | None = File(None, description="One or more ZIPs (multi-lap upload)"),
):
    multi_pairs: list[tuple[bytes, str]] = []
    single_bytes: bytes | None = None
    single_stem: str | None = None
    if files:
        for f in files:
            if not f.filename:
                continue
            if not f.filename.lower().endswith(".zip"):
                raise HTTPException(status_code=400, detail=f"Expected .zip files, got {f.filename!r}")
            stem = Path(f.filename).stem
            multi_pairs.append((await f.read(), stem))
    elif zip_file is not None and zip_file.filename:
        if not zip_file.filename.lower().endswith(".zip"):
            raise HTTPException(status_code=400, detail="Expected a .zip file")
        single_bytes = await zip_file.read()
        single_stem = Path(zip_file.filename).stem
    else:
        raise HTTPException(status_code=400, detail="Provide a ZIP file (zip_file) or multiple ZIPs (files)")

    if multi_pairs:
        logger.info(
            "Upload: %d zip(s): %s",
            len(multi_pairs),
            ", ".join(stem for _, stem in multi_pairs),
        )
    elif single_stem:
        logger.info("Upload: single zip %s", single_stem)

    job_id = create_job()

    async def run_job() -> None:
        await asyncio.to_thread(
            run_upload_job,
            job_id,
            multi_pairs,
            single_bytes,
            single_stem,
        )

    background_tasks.add_task(run_job)
    return {"job_id": job_id}


@app.post("/preview-gate")
def preview_gate(body: PreviewGateRequest):
    """
    After a map click: show where each lap snapped in GPS, trail heading, and virtual gate line
    (perpendicular to travel, e.g. E–W if riding north). No baro correlation.
    """
    try:
        df_a = telemetry_records_to_dataframe_preview(body.run_a_telemetry)
        df_b = telemetry_records_to_dataframe_preview(body.run_b_telemetry)
    except ValueError as e:
        logger.exception("preview-gate: bad telemetry payload")
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        return preview_gate_snap(
            df_a,
            df_b,
            body.gate_latitude,
            body.gate_longitude,
            gate_radius_m=body.gate_radius_m,
            half_width_m=body.gate_half_width_m,
        )
    except ValueError as e:
        logger.exception("preview-gate: snap failed")
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/align-baro")
def align_baro(body: AlignBaroRequest):
    """
    Start gate (map click) + FFT cross-correlation of Vz to time-align lap B vs A.
    Returns trimmed overlapping segment, gate-relative time_s, and Δt vs distance.
    """
    try:
        df_a = telemetry_records_to_dataframe(body.run_a_telemetry)
        df_b = telemetry_records_to_dataframe(body.run_b_telemetry)
    except ValueError as e:
        logger.exception("align-baro: bad telemetry payload")
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        a2, b2, meta = align_runs_at_gate_baro(
            df_a,
            df_b,
            body.gate_latitude,
            body.gate_longitude,
            gate_radius_m=body.gate_radius_m,
            vz_edge_eps=body.vz_edge_eps,
            correlation_max_distance_m=body.correlation_max_distance_m,
        )
    except ValueError as e:
        logger.exception("align-baro: alignment failed")
        raise HTTPException(status_code=400, detail=str(e)) from e

    if len(a2) < 10 or len(b2) < 10:
        raise HTTPException(
            status_code=400,
            detail="Too few samples after gate and overlap trim; widen gate radius or check telemetry.",
        )

    try:
        save_calculated_session_exports(
            [a2, b2],
            tag="align_baro",
            run_labels=[body.run_a_label or "run_A", body.run_b_label or "run_B"],
            run_sources=[body.run_a_source_name or "", body.run_b_source_name or ""],
        )
    except Exception:
        logger.exception("calculated_exports write failed (align-baro)")

    runs: list[dict[str, Any]] = []
    meta_labels = (body.run_a_label, body.run_b_label)
    meta_sources = (body.run_a_source_name, body.run_b_source_name)
    for i, proc in enumerate((a2, b2)):
        rd = run_dict_from_proc(proc)
        rd["run_id"] = i
        rd["label"] = meta_labels[i] or ordinal_run_label(i)
        src = meta_sources[i]
        if src:
            rd["source_name"] = src
        rd["color"] = RUN_COLORS[i % len(RUN_COLORS)]
        runs.append(rd)

    comparison = build_comparison_payload(a2, b2, ds_m=1.0)
    return {
        "runs": runs,
        "comparison": comparison,
        "run_count": 2,
        "alignment": meta,
    }


@app.post("/process-data-folder")
def process_data_folder(
    subpath: str = Query(
        ...,
        description="Folder name under project data/, e.g. Tenaka_Place-2026-04-10_17-12-46",
    ),
):
    """
    Process a Sensor Logger export directory from the repo's `data/` folder (local dev convenience).
    Path is constrained to stay under `data/` to avoid arbitrary filesystem access.
    """
    target = (_DATA_ROOT / subpath).resolve()
    try:
        target.relative_to(_DATA_ROOT.resolve())
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Path must be under data/") from e
    try:
        return process_directory(target)
    except ValueError as e:
        logger.exception("process-data-folder failed")
        raise HTTPException(status_code=400, detail=str(e)) from e
