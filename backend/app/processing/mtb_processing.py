"""MTB telemetry: 100 Hz master grid, IMU alignment, Butterworth conditioning, berm/braking/airtime features."""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd
from scipy.signal import find_peaks
from scipy.spatial.transform import Rotation as Rot3

from app.processing.constants import STANDARD_GRAVITY_MS2
from app.processing.dsp import butterworth_lowpass
from app.processing.ingest import tidy_hf_aux
from app.processing.merge_streams import merge_asof_on_unix_ns

STEP_NS = 10_000_000  # 0.01 s
TOLERANCE_NS = 50_000_000

_log = logging.getLogger(__name__)

# Stationary zero-cal window (fixed tilt on stem; bike not moving).
ZERO_CAL_DURATION_S = 2.0

# Ignore airtime / impact when GPS speed is below this (m/s). Kept low so slow trials rolls/drops still count;
# shuttle/standing false positives are less of a concern when laps are map-gated in the app workflow.
RIDER_SPEED_GATE_M_S = 0.5

# Airtime uses ‖TotalAcceleration‖/g (sqrt(x²+y²+z²)/9.80665): ~1g rolling, →0 in free fall.
# “Clean flight”: 2nd-order Butterworth LPF on raw G_total; takeoff peaks stay on raw; landing uses sustained G (50 Hz + 20 ms mean).
AIRTIME_TOTAL_G_MAX = 0.55
# Steep chute (median Vz very negative): stricter low-G cap (same ratio vs old 0.27/0.45).
AIRTIME_TOTAL_G_MAX_STRICT = 0.33
# Primary flight LPF: 10 Hz preserves weightless dips better than 20 Hz on chunky trails.
AIRTIME_FLIGHT_LOWPASS_HZ = 10.0
AIRTIME_FLIGHT_LOWPASS_ALT_HZ = 20.0
AIRTIME_MIN_DURATION_S = 0.20
AIRTIME_LANDING_WITHIN_S = 0.50
AIRTIME_TAKEOFF_LOOKBACK_S = 0.20
# Landing gate & reported G-Force use sustained load (50 Hz LPF + 20 ms mean), not single-sample raw spikes.
LANDING_IMPACT_LOWPASS_HZ = 50.0
LANDING_IMPACT_ROLLING_S = 0.020
LANDING_PEAK_MIN_G = 1.3
# Extra raw search after flight end (diagnostics): “delayed peak” hint if outside landing window.
AIRTIME_DIAG_EXTENDED_LAND_SEARCH_S = 2.0
# Pre-flight window max raw ‖a‖/g ≥ this → “Jump”; else “Drop” (takeoff optional for airtime).
JUMP_TAKEOFF_PEAK_MIN_G = 1.15
# Baro Vz median over flight below this (m/s) = falling through air (witness for smooth drops; not a hard gate).
AIRTIME_BARO_FALLING_MEDIAN_M_S = -1.5
# Cap debug “almost jump” rows returned when airtime is zero (avoid huge JSON).
AIRTIME_DEBUG_MAX_ALMOST = 25
# Steep descent: median Vz below this (m/s) triggers AIRTIME_TOTAL_G_MAX_STRICT.
AIRTIME_VZ_STRICT_BELOW_M_S = -5.0

# Naive “low ‖total acc‖” clock: raw G_total below this while GPS-moving; no sandwich, landing, or min segment.
SIMPLE_RAW_AIRTIME_G_MAX = 0.55

# Reported / mapped lean capped (phone roll can hit ~180°; gravity atan2 blows up when gz → 0).
LEAN_CAP_DEG = 62.0
LEAN_STAT_PERCENTILE = 99.2

_IMU_PREFIXES = ("acc_", "gravity_", "total_acc_", "gyro_", "acc_uncal_", "gyro_uncal_")


def _rotate_xyz_columns_inplace(df: pd.DataFrame, R: np.ndarray, prefix: str) -> None:
    """Apply v' = R @ v for rows where x,y,z columns exist under prefix."""
    sx, sy, sz = f"{prefix}x", f"{prefix}y", f"{prefix}z"
    if not all(c in df.columns for c in (sx, sy, sz)):
        return
    m = df[[sx, sy, sz]].to_numpy(dtype=np.float64)
    out = np.empty_like(m)
    for i in range(len(m)):
        row = np.nan_to_num(m[i], nan=0.0)
        out[i] = R @ row
    df[sx] = out[:, 0]
    df[sy] = out[:, 1]
    df[sz] = out[:, 2]


def apply_virtual_level_calibration(merged: pd.DataFrame, fs_hz: float) -> pd.DataFrame:
    """
    Zero-calibration: mean gravity over the first ~2 s (stationary bike) defines the mounting tilt.
    Build rotation R mapping that vector to +Z in a virtual level frame (+Z = “up” along calibrated gravity).

    Rotates all IMU 3-vectors (linear acc, gravity, total acc, gyro, uncal) before filtering / MTB features.
    Lean and braking use this frame (X = lateral, Y = longitudinal, Z = vertical).

    Part C (airtime / impacts): ‖total a‖ magnitude is unchanged by R, so mounting tilt is irrelevant.
    """
    if len(merged) < 3 or not np.isfinite(fs_hz) or fs_hz <= 0:
        return merged
    if not all(c in merged.columns for c in ("gravity_x", "gravity_y", "gravity_z")):
        merged.attrs["virtual_level_applied"] = False
        return merged

    n_cal = max(3, int(round(fs_hz * ZERO_CAL_DURATION_S)))
    n_cal = min(n_cal, len(merged))
    gx = merged["gravity_x"].to_numpy(dtype=np.float64)[:n_cal]
    gy = merged["gravity_y"].to_numpy(dtype=np.float64)[:n_cal]
    gz = merged["gravity_z"].to_numpy(dtype=np.float64)[:n_cal]
    g_mean = np.array(
        [float(np.nanmean(gx)), float(np.nanmean(gy)), float(np.nanmean(gz))],
        dtype=np.float64,
    )
    gn = np.linalg.norm(g_mean)
    if not np.isfinite(gn) or gn < 2.0:
        merged.attrs["virtual_level_applied"] = False
        return merged

    # 1D vectors match SciPy examples; unpack defensively (some versions return 3-tuples with sensitivity).
    u_unit = (g_mean / gn).astype(np.float64).reshape(3)
    target_unit = (
        np.array([0.0, 0.0, 1.0], dtype=np.float64)
        if float(np.nanmean(gz)) >= 0
        else np.array([0.0, 0.0, -1.0], dtype=np.float64)
    )
    _av = Rot3.align_vectors(target_unit, u_unit, return_sensitivity=False)
    rot = _av[0] if isinstance(_av, tuple) else _av
    R = rot.as_matrix()
    merged.attrs["virtual_level_R"] = R.tolist()
    merged.attrs["mtb_calibration_gravity_mean"] = g_mean.tolist()
    merged.attrs["virtual_level_applied"] = True

    for pfx in _IMU_PREFIXES:
        _rotate_xyz_columns_inplace(merged, R, pfx)

    return merged


def _tidy_aux_list(aux_frames: list[tuple[str, pd.DataFrame]]) -> list[tuple[str, pd.DataFrame]]:
    out: list[tuple[str, pd.DataFrame]] = []
    for name, raw in aux_frames:
        try:
            out.append((name, tidy_hf_aux(raw, name)))
        except Exception:
            continue
    return out


def mtb_build_100hz_master_grid(
    baro_df: pd.DataFrame,
    aux_frames: list[tuple[str, pd.DataFrame]],
) -> pd.DataFrame:
    """
    Uniform 10 ms time base; merge_asof barometer + all auxiliary IMU streams (nearest, 50 ms).
    time_s = 0 at first merged row (applied later in pipeline).
    """
    baro = baro_df.sort_values("unix_ns").reset_index(drop=True)
    if baro.empty:
        return baro

    tidies = _tidy_aux_list(aux_frames)
    t0 = int(baro["unix_ns"].iloc[0])
    t1 = int(baro["unix_ns"].iloc[-1])
    for _, tdf in tidies:
        if len(tdf) == 0:
            continue
        t0 = min(t0, int(tdf["unix_ns"].min()))
        t1 = max(t1, int(tdf["unix_ns"].max()))

    grid = np.arange(t0, t1 + STEP_NS, STEP_NS, dtype=np.int64)
    left = pd.DataFrame({"unix_ns": grid}).sort_values("unix_ns")
    out = pd.merge_asof(
        left,
        baro.sort_values("unix_ns"),
        on="unix_ns",
        direction="nearest",
        tolerance=TOLERANCE_NS,
    )

    for name, tdf in sorted(tidies, key=lambda x: x[0].lower()):
        if tdf.empty or len(tdf.columns) <= 1:
            continue
        cols = [c for c in tdf.columns if c != "unix_ns"]
        if not cols:
            continue
        sub = tdf[["unix_ns", *cols]].sort_values("unix_ns")
        out = merge_asof_on_unix_ns(out, sub)

    return out.sort_values("unix_ns").reset_index(drop=True)


def _contiguous_true_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive index ranges where mask is True."""
    runs: list[tuple[int, int]] = []
    n = len(mask)
    i = 0
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < n and mask[j]:
            j += 1
        runs.append((i, j - 1))
        i = j
    return runs


def _longest_true_subrun(mask: np.ndarray, a: int, b: int, min_len: int) -> tuple[int, int] | None:
    """Longest contiguous True stretch of mask within inclusive [a, b]; None if none ≥ min_len samples."""
    best: tuple[int, int] | None = None
    best_len = 0
    i = a
    while i <= b:
        while i <= b and not bool(mask[i]):
            i += 1
        if i > b:
            break
        j = i
        while j <= b and bool(mask[j]):
            j += 1
        seg_len = j - i
        if seg_len >= min_len and seg_len > best_len:
            best = (i, j - 1)
            best_len = seg_len
        i = j
    return best


def braking_intervals_along_distance(
    braking_active: np.ndarray,
    distance_m: np.ndarray,
) -> list[dict[str, float]]:
    if len(braking_active) == 0:
        return []
    d = np.asarray(distance_m, dtype=np.float64)
    intervals: list[dict[str, float]] = []
    for a, b in _contiguous_true_runs(np.asarray(braking_active, dtype=bool)):
        d0 = float(np.nanmin(d[a : b + 1]))
        d1 = float(np.nanmax(d[a : b + 1]))
        if np.isfinite(d0) and np.isfinite(d1):
            intervals.append({"start_m": min(d0, d1), "end_m": max(d0, d1)})
    return intervals


def sustained_landing_g_series(g_total_g: np.ndarray, fs_hz: float) -> np.ndarray:
    """50 Hz LPF on ‖total acc‖/g, then centered rolling mean (~20 ms) for impact / landing stats."""
    g_in = np.nan_to_num(np.asarray(g_total_g, dtype=np.float64), nan=1.0, posinf=1.0, neginf=0.0)
    lp = butterworth_lowpass(
        g_in,
        fs_hz=fs_hz,
        cutoff_hz=LANDING_IMPACT_LOWPASS_HZ,
        order=2,
    )
    win = max(3, int(round(LANDING_IMPACT_ROLLING_S * fs_hz)))
    return (
        pd.Series(lp)
        .rolling(win, center=True, min_periods=1)
        .mean()
        .to_numpy(dtype=np.float64)
    )


def _elapsed_s_at(merged: pd.DataFrame, idx: int) -> float:
    if not (0 <= idx < len(merged)):
        return float("nan")
    if "time_s" in merged.columns:
        v = float(merged["time_s"].iloc[idx])
        if np.isfinite(v):
            return v
    return float((int(merged["unix_ns"].iloc[idx]) - int(merged["unix_ns"].iloc[0])) * 1e-9)


def apply_mtb_features(
    merged: pd.DataFrame,
    fs_hz: float,
    *,
    diagnostic_run_label: str | None = None,
    log_airtime_rejections: bool = False,
) -> pd.DataFrame:
    """
    Lean from gravity, braking from filtered acc_y MA, airtime, impact peaks.
    Mutates merged; stores summary in merged.attrs[\"mtb_stats\"].

    log_airtime_rejections: when True (e.g. first lap), log candidate flight segments that fail sandwich gates.
    """
    stats: dict[str, Any] = {
        "max_lean_deg": 0.0,
        "total_airtime_s": 0.0,
        "jump_count": 0,
        "drop_count": 0,
        "drops_baro_witness": 0,
        # Max ‖total a‖/g peak while moving (raw series when available; prominence-filtered).
        "max_landing_impact_g": 0.0,
        "simple_airtime_s": 0.0,
    }
    g0 = STANDARD_GRAVITY_MS2
    n = len(merged)
    if n < 4 or not np.isfinite(fs_hz) or fs_hz <= 0:
        merged.attrs["mtb_stats"] = stats
        return merged

    # Part C: speed gate masks riding vs standing; airtime + landing use ‖total acceleration‖/g when available.
    speed = (
        merged["speed_m_s"].to_numpy(dtype=np.float64)
        if "speed_m_s" in merged.columns
        else np.full(n, np.nan, dtype=np.float64)
    )
    moving = np.isfinite(speed) & (speed > RIDER_SPEED_GATE_M_S)

    linear_g: np.ndarray | None = None
    if all(c in merged.columns for c in ("acc_x", "acc_y", "acc_z")):
        ax = merged["acc_x"].to_numpy(dtype=np.float64)
        ay = merged["acc_y"].to_numpy(dtype=np.float64)
        az = merged["acc_z"].to_numpy(dtype=np.float64)
        raw_mag = np.sqrt(np.nan_to_num(ax, nan=0.0) ** 2 + np.nan_to_num(ay, nan=0.0) ** 2 + np.nan_to_num(az, nan=0.0) ** 2)
        linear_g = raw_mag / g0
        merged["mtb_raw_total_g"] = linear_g

    total_g: np.ndarray | None = None
    if "total_accel_magnitude_ms2" in merged.columns:
        total_g = merged["total_accel_magnitude_ms2"].to_numpy(dtype=np.float64) / g0
        merged["mtb_total_accel_g"] = total_g

    # Raw ‖total_acc‖/g for impact peaks and sandwich takeoff/landing (filter dampens spikes).
    total_g_raw: np.ndarray | None = None
    if all(c in merged.columns for c in ("total_acc_x", "total_acc_y", "total_acc_z")):
        rx = merged["total_acc_x"].to_numpy(dtype=np.float64)
        ry = merged["total_acc_y"].to_numpy(dtype=np.float64)
        rz = merged["total_acc_z"].to_numpy(dtype=np.float64)
        total_g_raw = (
            np.sqrt(
                np.nan_to_num(rx, nan=0.0) ** 2
                + np.nan_to_num(ry, nan=0.0) ** 2
                + np.nan_to_num(rz, nan=0.0) ** 2
            )
            / g0
        )
    elif total_g is not None:
        total_g_raw = total_g.copy()

    peak_g = total_g_raw if total_g_raw is not None else total_g

    g_sustained: np.ndarray | None = None
    if peak_g is not None:
        g_sustained = sustained_landing_g_series(peak_g, fs_hz)
    elif linear_g is not None:
        g_sustained = sustained_landing_g_series(linear_g, fs_hz)

    # Raw ‖total acc‖/g near weightless, sample-by-sample (diagnostic / “feel” metric only).
    if peak_g is not None:
        pg0 = np.asarray(peak_g, dtype=np.float64)
        simple_mask = (pg0 < SIMPLE_RAW_AIRTIME_G_MAX) & moving & np.isfinite(pg0)
        stats["simple_airtime_s"] = float(np.sum(simple_mask) / fs_hz)

    # Landing G-Force: sustained load (50 Hz LPF + 20 ms rolling mean), not raw single-sample peaks.
    if g_sustained is not None and moving.any():
        tg = np.nan_to_num(g_sustained, nan=-np.inf)
        imp_masked = np.where(moving, tg, -np.inf)
        dist = max(1, int(0.06 * fs_hz))
        wlen = max(5, min(n - 1, dist * 3))
        height_gate = LANDING_PEAK_MIN_G if peak_g is not None else 2.0
        prom = 0.35 if peak_g is not None else 0.45
        _pk = find_peaks(
            imp_masked,
            height=height_gate,
            distance=dist,
            prominence=prom,
            wlen=wlen,
        )
        peaks = _pk[0]
        if len(peaks):
            stats["max_landing_impact_g"] = float(np.max(imp_masked[peaks]))
        else:
            stats["max_landing_impact_g"] = 0.0

    # Part A: lateral X — lean from gravity (virtual-level frame), else unfiltered gravity, else roll (Orientation).
    # Many Sensor Logger exports omit Gravity.csv but include Orientation.csv; roll gives a usable lean magnitude.
    def _lean_from_gx_gz(gx: np.ndarray, gz: np.ndarray) -> np.ndarray:
        n_cal = max(3, min(len(gx), int(round(fs_hz * ZERO_CAL_DURATION_S))))
        gx0 = float(np.nanmedian(gx[:n_cal]))
        gx_lat = gx - gx0
        # Stabilize atan2 when vertical gravity component is tiny (avoids ~90° spikes → bogus 178° “lean”).
        gz_safe = np.sign(gz) * np.maximum(np.abs(gz), 0.35 * g0)
        lean = np.abs(np.arctan2(gx_lat, gz_safe) * (180.0 / np.pi))
        return np.clip(lean, 0.0, LEAN_CAP_DEG)

    def _lean_stat_max(lean: np.ndarray) -> float:
        if not np.any(np.isfinite(lean)):
            return 0.0
        p = float(np.nanpercentile(lean[np.isfinite(lean)], LEAN_STAT_PERCENTILE))
        return float(min(p, LEAN_CAP_DEG)) if np.isfinite(p) else 0.0

    if all(c in merged.columns for c in ("gravity_x_filt", "gravity_z_filt")):
        gx = merged["gravity_x_filt"].to_numpy(dtype=np.float64)
        gz = merged["gravity_z_filt"].to_numpy(dtype=np.float64)
        lean = _lean_from_gx_gz(gx, gz)
        merged["mtb_lean_deg"] = lean
        stats["max_lean_deg"] = _lean_stat_max(lean)
    elif all(c in merged.columns for c in ("gravity_x", "gravity_z")):
        gx = merged["gravity_x"].to_numpy(dtype=np.float64)
        gz = merged["gravity_z"].to_numpy(dtype=np.float64)
        lean = _lean_from_gx_gz(gx, gz)
        merged["mtb_lean_deg"] = lean
        stats["max_lean_deg"] = _lean_stat_max(lean)
    elif "lean_angle_deg" in merged.columns:
        # Orientation roll (deg) wraps ±180; fold toward 0–90° bank-style lean, then cap.
        d = np.abs(merged["lean_angle_deg"].to_numpy(dtype=np.float64))
        d = np.where(d <= 90.0, d, 180.0 - d)
        lean = np.clip(d, 0.0, LEAN_CAP_DEG)
        merged["mtb_lean_deg"] = lean
        stats["max_lean_deg"] = _lean_stat_max(lean)
    else:
        merged["mtb_lean_deg"] = np.full(n, np.nan, dtype=np.float64)

    if "acc_y_filt" in merged.columns:
        ay_f = merged["acc_y_filt"].to_numpy(dtype=np.float64)
        win = max(3, int(round(fs_hz * 0.5)))
        ay_ma = pd.Series(ay_f).rolling(win, center=True, min_periods=1).mean().to_numpy(dtype=np.float64)
        merged["mtb_braking_ma_ms2"] = ay_ma
        merged["mtb_braking_active"] = ay_ma < -3.0
        merged["mtb_braking_intensity"] = np.abs(np.minimum(ay_ma, 0.0))
    else:
        merged["mtb_braking_ma_ms2"] = np.full(n, np.nan, dtype=np.float64)
        merged["mtb_braking_active"] = np.zeros(n, dtype=bool)
        merged["mtb_braking_intensity"] = np.zeros(n, dtype=np.float64)

    # Airtime: 10 Hz LPF on raw G_total for flight (20 Hz reference for diagnostics); raw peaks for landing.
    if peak_g is not None:
        _diag = diagnostic_run_label or "run"
        g_src = np.asarray(peak_g, dtype=np.float64)
        g_in = np.nan_to_num(g_src, nan=1.0, posinf=1.0, neginf=0.0)
        g_flight = butterworth_lowpass(
            g_in,
            fs_hz=fs_hz,
            cutoff_hz=AIRTIME_FLIGHT_LOWPASS_HZ,
            order=2,
        )
        g_flight_20 = butterworth_lowpass(
            g_in,
            fs_hz=fs_hz,
            cutoff_hz=AIRTIME_FLIGHT_LOWPASS_ALT_HZ,
            order=2,
        )
        candidate = (g_flight < AIRTIME_TOTAL_G_MAX) & moving & np.isfinite(g_flight)
        if log_airtime_rejections:
            _log.info(
                "[airtime diagnostic] %s | Flight LPF=%.0fHz (ref %.0fHz logged on rejects); "
                "flight<%.2fg; min duration %.2fs; landing raw >%.2fg within %.0fms; speed>%.1fm/s",
                _diag,
                AIRTIME_FLIGHT_LOWPASS_HZ,
                AIRTIME_FLIGHT_LOWPASS_ALT_HZ,
                AIRTIME_TOTAL_G_MAX,
                AIRTIME_MIN_DURATION_S,
                LANDING_PEAK_MIN_G,
                AIRTIME_LANDING_WITHIN_S * 1000.0,
                RIDER_SPEED_GATE_M_S,
            )
        vz = (
            merged["vz_m_s"].to_numpy(dtype=np.float64)
            if "vz_m_s" in merged.columns
            else np.full(n, np.nan, dtype=np.float64)
        )
        min_samples = max(3, int(np.ceil(AIRTIME_MIN_DURATION_S * fs_hz)))
        takeoff_n = max(1, int(round(AIRTIME_TAKEOFF_LOOKBACK_S * fs_hz)))
        land_n = max(1, int(round(AIRTIME_LANDING_WITHIN_S * fs_hz)))
        dt = 1.0 / fs_hz
        total_air = 0.0
        jump_count = 0
        drop_count = 0
        drops_baro_witness = 0
        almost: list[dict[str, Any]] = []
        validated_landing_max_g = 0.0
        pg = np.asarray(peak_g, dtype=np.float64)
        gs = np.asarray(g_sustained, dtype=np.float64) if g_sustained is not None else pg

        def _append_almost(row: dict[str, Any]) -> None:
            if len(almost) >= AIRTIME_DEBUG_MAX_ALMOST:
                return
            almost.append(row)

        for a, b in _contiguous_true_runs(candidate):
            seg_samples = b - a + 1
            seg_dur = seg_samples * dt
            if seg_samples < min_samples:
                _append_almost(
                    {
                        "start_sample": a,
                        "end_sample": b,
                        "duration_s": round(seg_dur, 3),
                        "fail_reason": "candidate_too_short",
                        "needed_min_duration_s": AIRTIME_MIN_DURATION_S,
                        "needed_min_samples": min_samples,
                    }
                )
                continue
            vz_med = float(np.nanmedian(vz[a : b + 1]))
            thr = (
                AIRTIME_TOTAL_G_MAX_STRICT
                if np.isfinite(vz_med) and vz_med < AIRTIME_VZ_STRICT_BELOW_M_S
                else AIRTIME_TOTAL_G_MAX
            )
            strict_mask = (g_flight < thr) & moving & np.isfinite(g_flight)
            refined = _longest_true_subrun(strict_mask, a, b, min_samples)
            if refined is None:
                _append_almost(
                    {
                        "start_sample": a,
                        "end_sample": b,
                        "duration_s": round(seg_dur, 3),
                        "fail_reason": "refine_duration",
                        "vz_median_m_s": vz_med if np.isfinite(vz_med) else None,
                        "low_g_threshold_g": thr,
                        "needed_min_duration_s": AIRTIME_MIN_DURATION_S,
                    }
                )
                if log_airtime_rejections:
                    t_a = _elapsed_s_at(merged, a)
                    t_b = _elapsed_s_at(merged, b)
                    mn10 = float(np.nanmin(g_flight[a : b + 1]))
                    mn20 = float(np.nanmin(g_flight_20[a : b + 1]))
                    _log.info(
                        "[airtime diagnostic] %s | Candidate flight [%.3fs–%.3fs] rejected — STRICT FLIGHT/DURATION "
                        "(need filtered G < %.2fg for ≥%.2fs inside window after steep-Vz cap; vz_median=%s). "
                        "Min LPF 10Hz=%.3fg, 20Hz=%.3fg; strict_thr=%.2fg. (Takeoff peak is not required for airtime.)",
                        _diag,
                        t_a,
                        t_b,
                        AIRTIME_TOTAL_G_MAX,
                        AIRTIME_MIN_DURATION_S,
                        f"{vz_med:.2f}" if np.isfinite(vz_med) else "n/a",
                        mn10,
                        mn20,
                        thr,
                    )
                continue
            a2, b2 = refined
            takeoff_max = float("nan")
            if a2 > 0:
                lo = max(0, a2 - takeoff_n)
                hi = a2
                if hi > lo:
                    pre = pg[lo:hi]
                    takeoff_max = float(np.nanmax(pre)) if pre.size else float("nan")
            lo2 = b2 + 1
            hi2 = min(n - 1, b2 + land_n)
            if lo2 > hi2:
                _append_almost(
                    {
                        "start_sample": a2,
                        "end_sample": b2,
                        "duration_s": round((b2 - a2 + 1) * dt, 3),
                        "fail_reason": "landing_peak",
                        "takeoff_max_g": round(takeoff_max, 3) if np.isfinite(takeoff_max) else None,
                        "jump_takeoff_threshold_g": JUMP_TAKEOFF_PEAK_MIN_G,
                        "landing_max_g": None,
                        "need_landing_g": LANDING_PEAK_MIN_G,
                        "note": "no_samples_after_segment",
                    }
                )
                if log_airtime_rejections:
                    t_a2 = _elapsed_s_at(merged, a2)
                    t_b2 = _elapsed_s_at(merged, b2)
                    _log.info(
                        "[airtime diagnostic] %s | Candidate flight [%.3fs–%.3fs] rejected — LANDING: "
                        "trace ends at flight end; no %.0fms window for sustained-landing search",
                        _diag,
                        t_a2,
                        t_b2,
                        AIRTIME_LANDING_WITHIN_S * 1000.0,
                    )
                continue
            post = gs[lo2 : hi2 + 1]
            if post.size:
                post_f = np.nan_to_num(post, nan=-np.inf)
                landing_max = float(np.max(post_f))
                imx_w = int(np.argmax(post_f))
                argmax_rel_ms = float((imx_w + 1) * dt * 1000.0)
            else:
                landing_max = float("nan")
                argmax_rel_ms = float("nan")
            ext_note = ""
            hi_ext = min(n - 1, b2 + max(land_n, int(AIRTIME_DIAG_EXTENDED_LAND_SEARCH_S * fs_hz)))
            if hi_ext > b2:
                ext = gs[b2 + 1 : hi_ext + 1]
                if ext.size:
                    ext_f = np.nan_to_num(ext, nan=-np.inf)
                    imx = int(np.argmax(ext_f))
                    ext_max = float(ext_f[imx])
                    ext_ms = (imx + 1) * dt * 1000.0
                    if ext_max >= LANDING_PEAK_MIN_G and (imx + 1) > land_n:
                        ext_note = (
                            f" Delayed sustained peak {ext_max:.2f}g at +{ext_ms:.0f}ms "
                            f"(beyond current {AIRTIME_LANDING_WITHIN_S * 1000:.0f}ms landing window)."
                        )
                    elif ext_max > landing_max and np.isfinite(landing_max):
                        ext_note = f" Extended search max {ext_max:.2f}g at +{ext_ms:.0f}ms."
            if not np.isfinite(landing_max) or landing_max < LANDING_PEAK_MIN_G:
                _append_almost(
                    {
                        "start_sample": a2,
                        "end_sample": b2,
                        "duration_s": round((b2 - a2 + 1) * dt, 3),
                        "fail_reason": "landing_peak",
                        "takeoff_max_g": round(takeoff_max, 3) if np.isfinite(takeoff_max) else None,
                        "jump_takeoff_threshold_g": JUMP_TAKEOFF_PEAK_MIN_G,
                        "landing_max_g": round(landing_max, 3) if np.isfinite(landing_max) else None,
                        "need_landing_g": LANDING_PEAK_MIN_G,
                    }
                )
                if log_airtime_rejections:
                    t_a2 = _elapsed_s_at(merged, a2)
                    t_b2 = _elapsed_s_at(merged, b2)
                    mn10 = float(np.nanmin(g_flight[a2 : b2 + 1]))
                    mn20 = float(np.nanmin(g_flight_20[a2 : b2 + 1]))
                    tk = (
                        f"pre-flight raw max={takeoff_max:.2f}g (jump if ≥{JUMP_TAKEOFF_PEAK_MIN_G}g)"
                        if np.isfinite(takeoff_max)
                        else "pre-flight raw max=n/a"
                    )
                    _log.info(
                        "[airtime diagnostic] %s | Candidate flight [%.3fs–%.3fs] rejected — LANDING GATE: "
                        "max sustained G (50Hz+20ms mean) in first %.0fms after flight = %.2fg (need >%.2fg); "
                        "argmax at +%.0fms. %s Min flight LPF 10Hz=%.3fg 20Hz=%.3fg.%s",
                        _diag,
                        t_a2,
                        t_b2,
                        AIRTIME_LANDING_WITHIN_S * 1000.0,
                        landing_max if np.isfinite(landing_max) else float("nan"),
                        LANDING_PEAK_MIN_G,
                        argmax_rel_ms if np.isfinite(argmax_rel_ms) else float("nan"),
                        tk,
                        mn10,
                        mn20,
                        ext_note,
                    )
                continue
            seg_dur_s = (b2 - a2 + 1) * dt
            total_air += seg_dur_s
            validated_landing_max_g = max(validated_landing_max_g, landing_max)
            vz_seg_med = float(np.nanmedian(vz[a2 : b2 + 1]))
            is_jump = (
                a2 > 0
                and np.isfinite(takeoff_max)
                and takeoff_max >= JUMP_TAKEOFF_PEAK_MIN_G
            )
            if is_jump:
                jump_count += 1
            else:
                drop_count += 1
                if np.isfinite(vz_seg_med) and vz_seg_med < AIRTIME_BARO_FALLING_MEDIAN_M_S:
                    drops_baro_witness += 1

        stats["total_airtime_s"] = float(total_air)
        stats["jump_count"] = int(jump_count)
        stats["drop_count"] = int(drop_count)
        stats["drops_baro_witness"] = int(drops_baro_witness)
        if total_air <= 1e-9 and almost:
            stats["almost_jumps"] = almost
        # Spec: max impact from raw spikes in landing-validation windows when we have any.
        if validated_landing_max_g > 0:
            stats["max_landing_impact_g"] = float(validated_landing_max_g)

    merged.attrs["mtb_stats"] = stats
    return merged
