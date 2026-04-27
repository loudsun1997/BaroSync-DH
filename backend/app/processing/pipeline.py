"""End-to-end: tidy -> GPS clean -> align -> DSP -> output records."""

from __future__ import annotations

import io
import json
import logging
import os
import re
import secrets
import zipfile
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ProgressCallback = Callable[[str, int], None]

import numpy as np
import pandas as pd

from app.processing.constants import STANDARD_GRAVITY_MS2, hypsometric_altitude_m
from app.processing.dsp import (
    bernoulli_correction_mbar,
    butterworth_lowpass,
    estimate_sample_rate_hz,
    low_frequency_drift_anchor,
    savgol_smooth_altitude,
    savgol_smooth_series,
    smooth_altitude_cubic_spline,
    vertical_velocity_m_s,
)
from app.processing.ingest import (
    classify_csv,
    load_csv_bytes,
    tidy_gps,
    tidy_hf_aux,
    tidy_highfreq,
)
from app.processing.cpu_workers import processing_worker_count
from app.processing.merge_streams import merge_baro_frames
from app.processing.mtb_processing import (
    apply_mtb_features,
    apply_virtual_level_calibration,
    braking_intervals_along_distance,
    mtb_build_100hz_master_grid,
)
from app.processing.spatial import cumulative_distance_m, filter_gps_outliers
from app.processing.viz_hints import compute_viz_hints
from app.processing.sync import interp_gps_to_master

_log = logging.getLogger(__name__)

RUN_COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00"]

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _calc_export_enabled() -> bool:
    v = os.environ.get("BAROSYNC_CALC_EXPORT", "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _to_jsonable(x: Any) -> Any:
    if isinstance(x, dict):
        return {str(k): _to_jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_to_jsonable(v) for v in x]
    if isinstance(x, (np.integer, np.int64, np.int32, np.uint64, np.uint32)):
        return int(x)
    if isinstance(x, (np.floating, np.float64, np.float32)):
        xf = float(x)
        return xf if np.isfinite(xf) else None
    if isinstance(x, np.ndarray):
        return _to_jsonable(x.tolist())
    if isinstance(x, (np.bool_,)):
        return bool(x)
    if isinstance(x, float):
        return x if np.isfinite(x) else None
    if isinstance(x, (str, int, bool)) or x is None:
        return x
    return str(x)


def save_calculated_session_exports(
    procs: list[pd.DataFrame],
    *,
    tag: str = "session",
    run_labels: list[str] | None = None,
    run_sources: list[str] | None = None,
) -> Path | None:
    """
    Write full-rate calculated DataFrames as plain CSV plus meta JSON per run under
    <repo>/calculated_exports/<UTC>_<tag>_<hex>/. Disable with BAROSYNC_CALC_EXPORT=0.
    """
    if not _calc_export_enabled() or not procs:
        return None
    out_root = _REPO_ROOT / "calculated_exports"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    sub = out_root / f"{stamp}_{tag}_{secrets.token_hex(3)}"
    sub.mkdir(parents=True, exist_ok=True)
    for i, proc in enumerate(procs):
        lab: str | None = None
        if run_labels and i < len(run_labels):
            lab = str(run_labels[i])
        elif run_sources and i < len(run_sources):
            lab = str(run_sources[i])
        safe = re.sub(r"[^\w\-.]+", "_", (lab or f"run_{i}"))[:64]
        stem = f"{i:02d}_{safe}"
        csv_path = sub / f"{stem}_full.csv"
        proc.to_csv(csv_path, index=False)
        meta: dict[str, Any] = {
            "stem": stem,
            "run_index": i,
            "label": lab,
            "n_rows": int(len(proc)),
            "columns": [str(c) for c in proc.columns],
            "dataframe_attrs": _to_jsonable(dict(proc.attrs)),
            "viz_hints": _to_jsonable(compute_viz_hints(proc)),
        }
        with (sub / f"{stem}_meta.json").open("w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    (sub / "README.txt").write_text(
        "BaroSync calculated export\n"
        "----------------------------\n"
        "*_full.csv  — plain CSV, full merged/proc DataFrame (open in Excel / Numbers / editor).\n"
        "              Vz columns include vz_m_s, vz_smooth_m_s (display), altitude_m, altitude_smooth_m, …\n"
        "*_meta.json — row count, column names, DataFrame attrs (e.g. mtb_stats), viz_hints.\n"
        "Disable writes: environment variable BAROSYNC_CALC_EXPORT=0\n",
        encoding="utf-8",
    )
    _log.info("Saved calculated telemetry export to %s", sub)
    return sub

# API JSON for the SPA: decimate aggressively so long runs do not freeze the browser.
# Calculated disk exports (*_full.csv) still use the full-rate ``proc`` DataFrame — not this path.
TELEMETRY_API_JSON_MAX_HZ = 8.0

# Populated in child processes via ProcessPoolExecutor initializer (avoids pickling aux per task).
_ctx_aux_pairs: list[tuple[str, pd.DataFrame]] | None = None


def _pool_init_aux_pairs(aux: list[tuple[str, pd.DataFrame]]) -> None:
    global _ctx_aux_pairs
    _ctx_aux_pairs = aux


def _worker_hf_for_baro(bf: pd.DataFrame) -> pd.DataFrame:
    aux = _ctx_aux_pairs
    if aux:
        return mtb_build_100hz_master_grid(bf, aux)
    return bf


def _worker_process_highfreq(trip: tuple[pd.DataFrame, pd.DataFrame, int]) -> pd.DataFrame:
    hf, gps, run_i = trip
    return process_highfreq_frame(hf, gps, run_index=run_i)


def _parallel_pool_workers(task_count: int) -> int:
    """0 = run sequentially (no process pool)."""
    cap = processing_worker_count()
    if cap <= 1 or task_count <= 1:
        return 0
    return min(cap, task_count)


def ordinal_run_label(index_zero_based: int) -> str:
    """Human-readable lap name: First run, Second run, 11th run, …"""
    n = index_zero_based + 1
    words = (
        "First",
        "Second",
        "Third",
        "Fourth",
        "Fifth",
        "Sixth",
        "Seventh",
        "Eighth",
        "Ninth",
        "Tenth",
    )
    if 1 <= n <= len(words):
        return f"{words[n - 1]} run"
    if n % 100 in (11, 12, 13):
        return f"{n}th run"
    last = n % 10
    if last == 1:
        return f"{n}st run"
    if last == 2:
        return f"{n}nd run"
    if last == 3:
        return f"{n}rd run"
    return f"{n}th run"


def _merge_highfreq_gps(hf: pd.DataFrame, gps_interp: pd.DataFrame) -> pd.DataFrame:
    return hf.merge(gps_interp, on="unix_ns", how="inner")


def process_highfreq_frame(
    hf: pd.DataFrame,
    gps: pd.DataFrame,
    *,
    run_index: int | None = None,
) -> pd.DataFrame:
    gps_c = filter_gps_outliers(gps)
    master_ns = hf["unix_ns"].to_numpy()
    gps_on_hf = interp_gps_to_master(gps_c, master_ns)
    merged = _merge_highfreq_gps(hf, gps_on_hf)

    fs = estimate_sample_rate_hz(merged["unix_ns"].to_numpy())
    merged = apply_virtual_level_calibration(merged, fs)

    alt_for_vz: np.ndarray | None = None

    if "pressure_mbar" in merged.columns:
        # Vz uses this snapshot: static hypsometric altitude only. Bernoulli ties pressure to GPS speed;
        # d|v|/dt injects spurious vertical rate (slow descents often read as uphill on the map).
        alt_for_vz = merged["altitude_m"].to_numpy(dtype=np.float64).copy()
        p = merged["pressure_mbar"].to_numpy(dtype=np.float64)
        v = merged["speed_m_s"].to_numpy(dtype=np.float64)
        alt_mean = float(np.nanmean(hypsometric_altitude_m(p)))
        corr_mbar = bernoulli_correction_mbar(v, altitude_m=alt_mean)
        p_corr = p + corr_mbar
        alt_uncorr = hypsometric_altitude_m(p)
        alt_corr = hypsometric_altitude_m(p_corr)
        merged["pressure_mbar_bernoulli_corrected"] = p_corr
        merged["altitude_from_pressure_m"] = alt_corr
        base = merged["altitude_m"].to_numpy(dtype=np.float64)
        merged["altitude_m"] = base + (alt_corr - alt_uncorr)

    if "relative_altitude_app_m" in merged.columns and "altitude_from_pressure_m" in merged.columns:
        app = merged["relative_altitude_app_m"].to_numpy(dtype=np.float64)
        pr_alt = merged["altitude_from_pressure_m"].to_numpy(dtype=np.float64)
        merged["sanity_pressure_minus_app_m"] = pr_alt - app

    # No pressure path: use current altitude (e.g. app relative) before GPS anchor.
    if alt_for_vz is None:
        alt_for_vz = merged["altitude_m"].to_numpy(dtype=np.float64).copy()

    # Display altitude below includes GPS low-frequency anchor; Vz does not (see alt_for_vz).

    if "gps_altitude_m" in merged.columns:
        gpi = merged["gps_altitude_m"].to_numpy(dtype=np.float64)
        if np.isfinite(np.nanmean(gpi)):
            gpi = pd.Series(gpi).ffill().bfill().to_numpy(dtype=np.float64)
            alt_b = merged["altitude_m"].to_numpy(dtype=np.float64)
            residual = gpi - alt_b
            anchor = low_frequency_drift_anchor(residual, fs_hz=fs)
            merged["gps_wgs84_residual_m"] = residual
            merged["gps_wgs84_anchor_offset_m"] = anchor
            merged["altitude_m"] = alt_b + anchor

    alt = merged["altitude_m"].to_numpy(dtype=np.float64)
    alt_filt = butterworth_lowpass(alt, fs_hz=fs, cutoff_hz=4.0, order=2)
    merged["altitude_filt_m"] = alt_filt
    alt_savgol = savgol_smooth_altitude(alt_filt, fs_hz=fs)
    merged["altitude_smooth_m"] = smooth_altitude_cubic_spline(merged["unix_ns"].to_numpy(), alt_savgol)
    ns = merged["unix_ns"].to_numpy()
    # Vz from baro altitude only (pre-GPS anchor); charts/maps still use blended altitude_smooth_m above.
    alt_filt_vz = butterworth_lowpass(alt_for_vz, fs_hz=fs, cutoff_hz=4.0, order=2)
    alt_savgol_vz = savgol_smooth_altitude(alt_filt_vz, fs_hz=fs)
    vz = vertical_velocity_m_s(alt_savgol_vz, ns)
    merged["vz_m_s"] = savgol_smooth_series(vz, fs_hz=fs, window_s=0.55, polyorder=2)

    for col in ("acc_x", "acc_y", "acc_z"):
        if col in merged.columns:
            merged[f"{col}_filt"] = butterworth_lowpass(
                merged[col].to_numpy(dtype=np.float64), fs_hz=fs, cutoff_hz=10.0, order=4
            )

    for ax in ("x", "y", "z"):
        gc = f"gravity_{ax}"
        if gc in merged.columns:
            merged[f"{gc}_filt"] = butterworth_lowpass(
                merged[gc].to_numpy(dtype=np.float64), fs_hz=fs, cutoff_hz=3.0, order=4
            )

    _motion_axis_pat = re.compile(
        r"^((?:total_acc|gyro|acc_uncal|gyro_uncal)_[xyz])(_filt)?$"
    )
    for col in list(merged.columns):
        m = _motion_axis_pat.match(col)
        if m and m.group(2) is None:
            base = m.group(1)
            merged[f"{base}_filt"] = butterworth_lowpass(
                merged[col].to_numpy(dtype=np.float64), fs_hz=fs, cutoff_hz=4.0, order=2
            )

    if all(c in merged.columns for c in ("total_acc_x_filt", "total_acc_y_filt", "total_acc_z_filt")):
        merged["total_accel_magnitude_ms2"] = np.sqrt(
            merged["total_acc_x_filt"] ** 2
            + merged["total_acc_y_filt"] ** 2
            + merged["total_acc_z_filt"] ** 2
        )

    if all(c in merged.columns for c in ("gyro_x_filt", "gyro_y_filt", "gyro_z_filt")):
        merged["gyro_magnitude_rad_s"] = np.sqrt(
            merged["gyro_x_filt"] ** 2 + merged["gyro_y_filt"] ** 2 + merged["gyro_z_filt"] ** 2
        )

    if all(c in merged.columns for c in ("acc_x_filt", "acc_y_filt", "acc_z_filt")):
        merged["linear_accel_magnitude_ms2"] = np.sqrt(
            merged["acc_x_filt"] ** 2 + merged["acc_y_filt"] ** 2 + merged["acc_z_filt"] ** 2
        )
        merged["g_total"] = merged["linear_accel_magnitude_ms2"] / STANDARD_GRAVITY_MS2
        t_sec = merged["unix_ns"].astype(np.float64) * 1e-9
        ax = merged["acc_x_filt"].to_numpy(dtype=np.float64)
        ay = merged["acc_y_filt"].to_numpy(dtype=np.float64)
        az = merged["acc_z_filt"].to_numpy(dtype=np.float64)
        jx = np.gradient(np.nan_to_num(ax, nan=0.0), t_sec)
        jy = np.gradient(np.nan_to_num(ay, nan=0.0), t_sec)
        jz = np.gradient(np.nan_to_num(az, nan=0.0), t_sec)
        merged["jerk_magnitude_ms3"] = np.sqrt(jx * jx + jy * jy + jz * jz)

    if "roll_rad" in merged.columns:
        merged["roll_rad_filt"] = butterworth_lowpass(
            merged["roll_rad"].to_numpy(dtype=np.float64), fs_hz=fs, cutoff_hz=4.0, order=2
        )
        roll = merged["roll_rad_filt"].to_numpy(dtype=np.float64)
        merged["lean_angle_deg"] = np.degrees(roll)
        g = STANDARD_GRAVITY_MS2
        expected_lat = g * np.tan(np.clip(roll, -1.25, 1.25))
        merged["berm_expected_lateral_ms2"] = expected_lat
        if all(c in merged.columns for c in ("acc_x_filt", "acc_y_filt")):
            measured_lat = np.sqrt(merged["acc_x_filt"] ** 2 + merged["acc_y_filt"] ** 2)
            merged["berm_measured_lateral_ms2"] = measured_lat
            merged["berm_balance_ratio"] = measured_lat / np.maximum(np.abs(expected_lat), 0.75)

    for ori_col in ("pitch_rad", "yaw_rad"):
        if ori_col in merged.columns:
            merged[f"{ori_col}_filt"] = butterworth_lowpass(
                merged[ori_col].to_numpy(dtype=np.float64), fs_hz=fs, cutoff_hz=4.0, order=2
            )

    merged["distance_m"] = cumulative_distance_m(
        merged["latitude"].to_numpy(), merged["longitude"].to_numpy()
    )
    merged["time_s"] = (merged["unix_ns"].astype(np.float64) - float(merged["unix_ns"].iloc[0])) * 1e-9
    vz_series = pd.Series(merged["vz_m_s"].to_numpy(dtype=np.float64))
    win_vz = max(3, int(fs * 0.5))
    merged["vz_rolling_std"] = vz_series.rolling(win_vz, center=True, min_periods=1).std().to_numpy(dtype=np.float64)
    # Display-only: heavy LPF + SG kills suspension-band chatter for map / elevation heat profile (MTB uses vz_m_s).
    vz_lp_vis = butterworth_lowpass(
        merged["vz_m_s"].to_numpy(dtype=np.float64), fs_hz=fs, cutoff_hz=0.5, order=2
    )
    merged["vz_smooth_m_s"] = savgol_smooth_series(
        vz_lp_vis, fs_hz=fs, window_s=1.5, polyorder=2
    )
    merged = apply_mtb_features(
        merged,
        fs,
        diagnostic_run_label=ordinal_run_label(run_index) if run_index is not None else None,
        log_airtime_rejections=(run_index == 0),
    )
    return merged


def _telemetry_export_column_names(df: pd.DataFrame) -> list[str]:
    cols = [
        "unix_ns",
        "latitude",
        "longitude",
        "altitude_m",
        "altitude_smooth_m",
        "vz_m_s",
        "vz_smooth_m_s",
        "speed_m_s",
        "distance_m",
        "time_s",
    ]
    extra = [
        c
        for c in (
            "g_total",
            "linear_accel_magnitude_ms2",
            "total_accel_magnitude_ms2",
            "gyro_magnitude_rad_s",
            "pressure_mbar",
            "relative_altitude_app_m",
            "sanity_pressure_minus_app_m",
            "gps_wgs84_anchor_offset_m",
            "gps_wgs84_residual_m",
            "roll_rad",
            "roll_rad_filt",
            "pitch_rad",
            "pitch_rad_filt",
            "yaw_rad",
            "yaw_rad_filt",
            "lean_angle_deg",
            "berm_expected_lateral_ms2",
            "berm_measured_lateral_ms2",
            "berm_balance_ratio",
            "jerk_magnitude_ms3",
            "vz_rolling_std",
            "mtb_raw_total_g",
            "mtb_total_accel_g",
            "mtb_lean_deg",
            "mtb_braking_ma_ms2",
            "mtb_braking_intensity",
            "mtb_braking_active",
        )
        if c in df.columns
    ]
    motion_pat = re.compile(
        r"^(?:acc|total_acc|gyro|acc_uncal|gyro_uncal|gravity)_[xyz](?:_filt)?$"
    )
    for c in sorted(df.columns):
        if c in cols or c in extra:
            continue
        if motion_pat.match(c):
            extra.append(c)
    return [c for c in cols + extra if c in df.columns]


def decimate_dataframe_for_export(df: pd.DataFrame, max_hz: float) -> pd.DataFrame:
    if len(df) < 2 or not np.isfinite(max_hz) or max_hz <= 0:
        return df
    fs = float(estimate_sample_rate_hz(df["unix_ns"].to_numpy()))
    if not np.isfinite(fs) or fs <= max_hz:
        return df
    step = max(1, int(round(fs / max_hz)))
    return df.iloc[::step].copy()


def _series_to_jsonable_list(s: pd.Series) -> list[Any]:
    """JSON-safe lists: NaN/inf → None; preserve bool and int for unix_ns."""
    if pd.api.types.is_bool_dtype(s.dtype):
        out: list[Any] = []
        for v in s.tolist():
            if v is None or (isinstance(v, (float, np.floating)) and pd.isna(v)):
                out.append(None)
            else:
                out.append(bool(v))
        return out
    if pd.api.types.is_integer_dtype(s.dtype):
        out_i: list[Any] = []
        for v in s.tolist():
            if v is None or pd.isna(v):
                out_i.append(None)
            else:
                out_i.append(int(v))
        return out_i
    arr = pd.to_numeric(s, errors="coerce").to_numpy(dtype=np.float64, copy=False)
    out_f: list[Any] = []
    for x in arr.flat:
        if np.isfinite(x):
            out_f.append(float(x))
        else:
            out_f.append(None)
    return out_f


def dataframe_to_telemetry_columns(df: pd.DataFrame) -> dict[str, Any]:
    """Column-oriented telemetry for JSON (faster than one dict per sample)."""
    use = _telemetry_export_column_names(df)
    sub = df[use]
    return {c: _series_to_jsonable_list(sub[c]) for c in use}


def run_dict_from_proc(proc: pd.DataFrame) -> dict[str, Any]:
    vz = proc["vz_m_s"].to_numpy(dtype=np.float64)
    smoothness = float(1.0 / (float(np.nanstd(vz)) + 1e-6))
    mtb_stats = None
    if getattr(proc, "attrs", None) is not None and "mtb_stats" in proc.attrs:
        mtb_stats = dict(proc.attrs["mtb_stats"])
    braking_intervals_m: list[dict[str, float]] | None = None
    if "mtb_braking_active" in proc.columns and "distance_m" in proc.columns:
        braking_intervals_m = braking_intervals_along_distance(
            proc["mtb_braking_active"].to_numpy(dtype=bool),
            proc["distance_m"].to_numpy(dtype=np.float64),
        )
    proc_telemetry = decimate_dataframe_for_export(proc, TELEMETRY_API_JSON_MAX_HZ)
    alt_col = "altitude_smooth_m" if "altitude_smooth_m" in proc_telemetry.columns else "altitude_m"
    s_api = proc_telemetry["distance_m"].to_numpy(dtype=np.float64)
    h_api = proc_telemetry[alt_col].to_numpy(dtype=np.float64)
    sample_rate_hz = float(estimate_sample_rate_hz(proc["unix_ns"].to_numpy()))
    return {
        "telemetry": dataframe_to_telemetry_columns(proc_telemetry),
        "altitude_vs_distance": {
            "distance_m": s_api.tolist(),
            "altitude_m": np.asarray(h_api, dtype=np.float64).tolist(),
        },
        "sample_rate_hz": sample_rate_hz,
        "smoothness_score": smoothness,
        "mtb_stats": mtb_stats,
        "braking_intervals_m": braking_intervals_m,
        "viz_hints": compute_viz_hints(proc),
    }


def process_single_run_from_frames(gps: pd.DataFrame, hf: pd.DataFrame) -> dict[str, Any]:
    return run_dict_from_proc(process_highfreq_frame(hf, gps, run_index=0))


def _report_progress(cb: ProgressCallback | None, step: str, pct: int) -> None:
    if cb is not None:
        cb(step, max(0, min(100, pct)))


def process_session_csv_items(
    items: list[tuple[str, pd.DataFrame]],
    *,
    run_source_stems: list[str] | None = None,
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """items: (filename, dataframe) e.g. Location.csv + Barometer.csv + Accelerometer.csv."""
    _report_progress(progress, "Reading and classifying CSVs…", 5)
    gps_items: list[tuple[str, pd.DataFrame]] = []
    baro_items: list[tuple[str, pd.DataFrame]] = []
    aux_items: list[tuple[str, pd.DataFrame]] = []

    for name, df in items:
        base_name = Path(name).name
        kind = classify_csv(df, base_name)
        if kind == "metadata":
            continue
        try:
            if kind == "gps":
                gps_items.append((base_name, tidy_gps(df)))
            elif kind == "hf_baro":
                baro_items.append((base_name, tidy_highfreq(df)))
            elif kind == "hf_aux":
                aux_items.append((base_name, df))
        except Exception:
            continue

    gps_items.sort(key=lambda x: x[0].lower())
    baro_items.sort(key=lambda x: x[0].lower())
    aux_items.sort(key=lambda x: x[0].lower())

    if not baro_items:
        raise ValueError("Session must include at least one barometer / relative-altitude CSV (e.g. Barometer.csv)")
    if not gps_items:
        raise ValueError("Session must include at least one GPS / Location CSV")

    _report_progress(progress, "Tidying GPS and sensor streams…", 18)

    gps_frames = [df for _, df in gps_items]
    baro_only = [df for _, df in baro_items]
    # Pairs (not bare DataFrames): mtb_build iterates `for name, raw in aux`, and unpacking a DataFrame
    # iterates all column names — Python requires an exact unpack count, so >2 columns raised ValueError.
    aux_pairs: list[tuple[str, pd.DataFrame]] = list(aux_items)

    def hf_for_baro_block(bf: pd.DataFrame) -> pd.DataFrame:
        if aux_pairs:
            return mtb_build_100hz_master_grid(bf, aux_pairs)
        return bf

    if len(gps_frames) == 1:
        _report_progress(progress, "Merging barometer and IMU into time grid…", 28)
        fused_baro = merge_baro_frames(baro_only)
        fused_baro = hf_for_baro_block(fused_baro)
        hf_per_run = [fused_baro]
    elif len(gps_frames) == len(baro_only):
        m_baro = len(baro_only)
        pw = _parallel_pool_workers(m_baro)
        if pw > 1:
            _report_progress(
                progress,
                f"Merging barometer / IMU per lap ({m_baro} parallel)…",
                30,
            )
            _log.info(
                "Parallel HF grid merge: %d baro block(s), %d worker process(es), cpu cap=%d",
                m_baro,
                pw,
                processing_worker_count(),
            )
            with ProcessPoolExecutor(
                max_workers=pw,
                initializer=_pool_init_aux_pairs,
                initargs=(aux_pairs,),
            ) as ex:
                hf_per_run = list(ex.map(_worker_hf_for_baro, baro_only))
        else:
            _report_progress(progress, "Merging barometer and IMU per lap…", 30)
            hf_per_run = [hf_for_baro_block(bf) for bf in baro_only]
    else:
        raise ValueError(
            f"For multiple laps, provide matching GPS and barometer CSV counts (sorted by path), "
            f"or a single GPS file for the whole session. Got {len(gps_frames)} GPS and {len(baro_only)} barometer file(s)."
        )

    n = min(len(gps_frames), len(hf_per_run))
    pw = _parallel_pool_workers(n)
    if pw > 1:
        _report_progress(progress, f"Signal processing: {n} lap(s) in parallel…", 45)
        _log.info(
            "Parallel lap DSP: %d lap(s), %d worker process(es), cpu cap=%d",
            n,
            pw,
            processing_worker_count(),
        )
        triples = [(hf_per_run[i], gps_frames[i], i) for i in range(n)]
        with ProcessPoolExecutor(max_workers=pw) as ex:
            procs = list(ex.map(_worker_process_highfreq, triples))
        _report_progress(progress, "Parallel DSP complete", 88)
    else:
        procs = []
        for i in range(n):
            _report_progress(
                progress,
                f"Signal processing: lap {i + 1} of {n}…",
                42 + int(48 * (i + 1) / max(n, 1)),
            )
            procs.append(process_highfreq_frame(hf_per_run[i], gps_frames[i], run_index=i))

    _report_progress(progress, "Building run payloads…", 93)

    runs: list[dict[str, Any]] = []
    for i in range(n):
        rd = run_dict_from_proc(procs[i])
        rd["run_id"] = i
        rd["label"] = ordinal_run_label(i)
        if run_source_stems:
            if len(run_source_stems) == n:
                rd["source_name"] = run_source_stems[i]
            elif len(run_source_stems) == 1:
                rd["source_name"] = run_source_stems[0]
        rd["color"] = RUN_COLORS[i % len(RUN_COLORS)]
        runs.append(rd)

    # Multi-lap Δt and overlay alignment use barometer cross-correlation + start gate (POST /align-baro).
    comparison: dict[str, Any] | None = None

    if _calc_export_enabled():
        try:
            labs = [ordinal_run_label(i) for i in range(n)]
            save_calculated_session_exports(
                procs,
                tag="session",
                run_labels=labs,
                run_sources=run_source_stems,
            )
        except Exception:
            _log.exception("calculated_exports write failed")

    _report_progress(progress, "Ready", 99)
    return {"runs": runs, "comparison": comparison, "run_count": n}


def _zip_bytes_to_items(data: bytes, name_prefix: str = "") -> list[tuple[str, pd.DataFrame]]:
    items: list[tuple[str, pd.DataFrame]] = []
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        for name in zf.namelist():
            if name.endswith("/") or not name.lower().endswith(".csv"):
                continue
            try:
                df = load_csv_bytes(zf.read(name))
            except Exception:
                continue
            base = Path(name).name
            items.append((f"{name_prefix}{base}", df))
    return items


def process_zip_bytes(
    data: bytes,
    *,
    source_stem: str | None = None,
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    _report_progress(progress, "Reading ZIP archive…", 2)
    raw_items = _zip_bytes_to_items(data, name_prefix="")
    _report_progress(progress, "Extracting CSVs from ZIP…", 6)

    def session_progress(step: str, pct: int) -> None:
        if progress is not None:
            progress(step, 8 + int(90 * pct / 100))

    out = process_session_csv_items(raw_items, progress=session_progress if progress else None)
    if source_stem and out.get("runs"):
        for rd in out["runs"]:
            rd["source_name"] = source_stem
    return out


def process_multi_zip_bytes(
    raw_list: list[tuple[bytes, str]],
    *,
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Merge CSVs from several ZIPs (prefixed names so laps pair by upload order).

    Each tuple is (zip bytes, display stem without .zip, e.g. session folder name).
    """
    if not raw_list:
        raise ValueError("No ZIP archives provided")
    m = len(raw_list)
    items: list[tuple[str, pd.DataFrame]] = []
    stems: list[str] = []
    for zi, (data, stem) in enumerate(raw_list):
        _report_progress(
            progress,
            f"Reading ZIP {zi + 1} of {m}…",
            max(1, int(12 * (zi + 1) / m)),
        )
        items.extend(_zip_bytes_to_items(data, name_prefix=f"z{zi}_"))
        stems.append(stem)

    def session_progress(step: str, pct: int) -> None:
        if progress is not None:
            progress(step, 15 + int(83 * pct / 100))

    return process_session_csv_items(
        items,
        run_source_stems=stems,
        progress=session_progress if progress else None,
    )


def process_directory(dir_path: str | Path) -> dict[str, Any]:
    """Load all *.csv in a folder (Sensor Logger export directory)."""
    root = Path(dir_path).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Not a directory: {root}")
    items: list[tuple[str, pd.DataFrame]] = []
    for path in sorted(root.iterdir()):
        if path.suffix.lower() != ".csv":
            continue
        try:
            items.append((path.name, pd.read_csv(path)))
        except Exception:
            continue
    if not items:
        raise ValueError(f"No readable CSV files in {root}")
    return process_session_csv_items(items)
