"""N-run canonical 1D reference trail synthesis.

The synthesis path intentionally keeps GPS as a distance index only. Elevation
shape comes from pressure altitude cleaned with a Bernoulli correction and a
light 1D baro/IMU fusion pass, then aligned and averaged in SRVF space.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from scipy.signal import savgol_filter
from scipy.spatial.distance import euclidean

from app.processing.constants import STANDARD_GRAVITY_MS2, hypsometric_altitude_m
from app.processing.dsp import (
    bernoulli_correction_mbar,
    butterworth_lowpass,
    estimate_sample_rate_hz,
    vertical_velocity_m_s,
)
from app.processing.compare import distance_and_time_for_delta_t, resample_time_on_distance_grid
from app.processing.spatial import cumulative_distance_m

try:  # Optional in local dev until backend requirements are installed.
    from fastdtw import fastdtw
except Exception:  # pragma: no cover - exercised only when dependency is absent.
    fastdtw = None  # type: ignore[assignment]

try:  # Optional fallback keeps the endpoint usable in constrained environments.
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import ConstantKernel, RBF, WhiteKernel
except Exception:  # pragma: no cover
    GaussianProcessRegressor = None  # type: ignore[assignment]
    ConstantKernel = None  # type: ignore[assignment]
    RBF = None  # type: ignore[assignment]
    WhiteKernel = None  # type: ignore[assignment]


DEFAULT_GRID_DS_M = 1.0
MAX_GPR_TRAIN_POINTS = 2_500


@dataclass(frozen=True)
class _FusedRun:
    distance_m: np.ndarray
    altitude_m: np.ndarray
    vz_m_s: np.ndarray
    sample_rate_hz: float


def _jsonable_float_list(x: np.ndarray) -> list[float | None]:
    out: list[float | None] = []
    for v in np.asarray(x, dtype=np.float64).flat:
        out.append(float(v) if np.isfinite(v) else None)
    return out


def _finite_fill(y: np.ndarray, fill_value: float = 0.0) -> np.ndarray:
    x = np.asarray(y, dtype=np.float64)
    if x.size == 0:
        return x
    mask = np.isfinite(x)
    if not mask.any():
        return np.full_like(x, fill_value, dtype=np.float64)
    if mask.all():
        return x.astype(np.float64, copy=True)
    idx = np.arange(len(x), dtype=np.float64)
    return np.interp(idx, idx[mask], x[mask]).astype(np.float64)


def _safe_col(df: pd.DataFrame, names: tuple[str, ...], default: float = 0.0) -> np.ndarray:
    for name in names:
        if name in df.columns:
            return _finite_fill(pd.to_numeric(df[name], errors="coerce").to_numpy(dtype=np.float64), default)
    return np.full(len(df), default, dtype=np.float64)


def _whiten_ar1_preserve_low_frequency(altitude_m: np.ndarray, fs_hz: float) -> np.ndarray:
    """AR(1) whitening of short-term residuals while leaving trail-scale shape intact."""
    h = _finite_fill(altitude_m)
    if len(h) < 8:
        return h
    cutoff_hz = min(0.35, max(0.03, fs_hz / 80.0))
    try:
        trend = butterworth_lowpass(h, fs_hz=fs_hz, cutoff_hz=cutoff_hz, order=2)
    except Exception:
        win = max(5, int(round(fs_hz * 2.0)) | 1)
        if win >= len(h):
            win = max(5, len(h) - (1 - len(h) % 2))
        trend = savgol_filter(h, win, min(2, win - 1)) if win >= 5 else h
    resid = h - trend
    r0 = resid[:-1]
    r1 = resid[1:]
    denom = float(np.dot(r0, r0)) + 1e-12
    phi = float(np.clip(np.dot(r0, r1) / denom, -0.98, 0.98))
    white = resid.copy()
    white[1:] = resid[1:] - phi * resid[:-1]
    return trend + white


def _corrected_baro_altitude(df: pd.DataFrame) -> np.ndarray:
    if "pressure_mbar" in df.columns:
        p = _safe_col(df, ("pressure_mbar",), default=np.nan)
        speed = _safe_col(df, ("speed_m_s",), default=0.0)
        alt_uncorr = hypsometric_altitude_m(p)
        alt_mean = float(np.nanmean(alt_uncorr)) if np.isfinite(np.nanmean(alt_uncorr)) else 0.0
        p_corr = p + bernoulli_correction_mbar(speed, altitude_m=alt_mean)
        return hypsometric_altitude_m(p_corr)
    if "altitude_from_pressure_m" in df.columns:
        return _safe_col(df, ("altitude_from_pressure_m",), default=0.0)
    if "altitude_smooth_m" in df.columns:
        return _safe_col(df, ("altitude_smooth_m",), default=0.0)
    if "altitude_m" in df.columns:
        return _safe_col(df, ("altitude_m",), default=0.0)
    raise ValueError("Telemetry must include pressure_mbar or an altitude column")


def _vertical_linear_accel(df: pd.DataFrame) -> np.ndarray:
    """Approximate nav-frame vertical linear acceleration from available IMU columns."""
    n = len(df)
    if n == 0:
        return np.empty(0, dtype=np.float64)
    if all(c in df.columns for c in ("gravity_x_filt", "gravity_y_filt", "gravity_z_filt")):
        gx = _safe_col(df, ("gravity_x_filt", "gravity_x"))
        gy = _safe_col(df, ("gravity_y_filt", "gravity_y"))
        gz = _safe_col(df, ("gravity_z_filt", "gravity_z"))
        gnorm = np.maximum(np.sqrt(gx * gx + gy * gy + gz * gz), 1e-6)
        ux, uy, uz = gx / gnorm, gy / gnorm, gz / gnorm
        if all(c in df.columns for c in ("total_acc_x_filt", "total_acc_y_filt", "total_acc_z_filt")):
            ax = _safe_col(df, ("total_acc_x_filt", "total_acc_x"))
            ay = _safe_col(df, ("total_acc_y_filt", "total_acc_y"))
            az = _safe_col(df, ("total_acc_z_filt", "total_acc_z"))
            down_component = ax * ux + ay * uy + az * uz
            return -(down_component - STANDARD_GRAVITY_MS2)
        if all(c in df.columns for c in ("acc_x_filt", "acc_y_filt", "acc_z_filt")):
            ax = _safe_col(df, ("acc_x_filt", "acc_x"))
            ay = _safe_col(df, ("acc_y_filt", "acc_y"))
            az = _safe_col(df, ("acc_z_filt", "acc_z"))
            return -(ax * ux + ay * uy + az * uz)
    if "acc_z_filt" in df.columns:
        az = _safe_col(df, ("acc_z_filt", "acc_z"))
        return az - float(np.nanmedian(az))
    return np.zeros(n, dtype=np.float64)


def _ekf_vertical_fusion(
    unix_ns: np.ndarray,
    baro_altitude_m: np.ndarray,
    vertical_accel_ms2: np.ndarray,
    fs_hz: float,
) -> tuple[np.ndarray, np.ndarray]:
    h_meas = _finite_fill(baro_altitude_m)
    a = _finite_fill(vertical_accel_ms2)
    n = len(h_meas)
    if n < 2:
        return h_meas, np.zeros_like(h_meas)

    t = _finite_fill(np.asarray(unix_ns, dtype=np.float64)) * 1e-9
    dt_arr = np.diff(t, prepend=t[0])
    nominal_dt = 1.0 / max(float(fs_hz), 1.0)
    dt_arr = np.clip(np.nan_to_num(dt_arr, nan=nominal_dt, posinf=nominal_dt, neginf=nominal_dt), 1e-4, 0.5)

    x = np.array([h_meas[0], 0.0, 0.0], dtype=np.float64)
    p = np.diag([4.0, 4.0, 0.8]).astype(np.float64)
    q_acc = 0.6
    q_bias = 0.01
    meas_var = max(float(np.nanvar(h_meas - butterworth_lowpass(h_meas, fs_hz, cutoff_hz=0.5, order=2))), 0.35**2)
    r = np.array([[meas_var]], dtype=np.float64)
    h_mat = np.array([[1.0, 0.0, 0.0]], dtype=np.float64)
    eye = np.eye(3)

    out_h = np.empty(n, dtype=np.float64)
    out_v = np.empty(n, dtype=np.float64)
    for i in range(n):
        dt = float(dt_arr[i])
        ai = float(a[i])
        acc = ai - x[2]
        x = np.array(
            [
                x[0] + x[1] * dt + 0.5 * acc * dt * dt,
                x[1] + acc * dt,
                x[2],
            ],
            dtype=np.float64,
        )
        f = np.array(
            [[1.0, dt, -0.5 * dt * dt], [0.0, 1.0, -dt], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )
        q = np.diag([0.25 * dt**4 * q_acc, dt * dt * q_acc, dt * q_bias]).astype(np.float64)
        p = f @ p @ f.T + q

        z = h_meas[i]
        if np.isfinite(z):
            y = np.array([[z - x[0]]], dtype=np.float64)
            s = h_mat @ p @ h_mat.T + r
            k = p @ h_mat.T @ np.linalg.inv(s)
            x = x + (k @ y).ravel()
            p = (eye - k @ h_mat) @ p
        out_h[i] = x[0]
        out_v[i] = x[1]
    return out_h, np.clip(out_v, -50.0, 50.0)


def _prepare_run(df: pd.DataFrame) -> _FusedRun:
    for col in ("unix_ns", "latitude", "longitude"):
        if col not in df.columns:
            raise ValueError(f"Telemetry missing required column: {col}")
    df = df.sort_values("unix_ns").reset_index(drop=True)
    if len(df) < 4:
        raise ValueError("Each run needs at least 4 samples")
    fs = float(estimate_sample_rate_hz(df["unix_ns"].to_numpy(dtype=np.float64)))
    baro_alt = _corrected_baro_altitude(df)
    baro_alt = _whiten_ar1_preserve_low_frequency(baro_alt, fs)
    vertical_accel = _vertical_linear_accel(df)
    fused_h, fused_v = _ekf_vertical_fusion(
        df["unix_ns"].to_numpy(dtype=np.float64),
        baro_alt,
        vertical_accel,
        fs,
    )
    if "distance_m" in df.columns:
        dist = _safe_col(df, ("distance_m",), default=0.0)
    else:
        dist = cumulative_distance_m(df["latitude"].to_numpy(dtype=np.float64), df["longitude"].to_numpy(dtype=np.float64))
    order = np.argsort(dist)
    dist = dist[order]
    fused_h = fused_h[order]
    fused_v = fused_v[order]
    keep = np.isfinite(dist) & np.isfinite(fused_h)
    dist, fused_h, fused_v = dist[keep], fused_h[keep], fused_v[keep]
    if len(dist) < 4 or float(np.nanmax(dist) - np.nanmin(dist)) <= 1.0:
        raise ValueError("Run does not contain a usable distance span")
    uniq, idx = np.unique(dist, return_index=True)
    return _FusedRun(uniq, fused_h[idx], fused_v[idx], fs)


def _common_grid(runs: list[_FusedRun], ds_m: float) -> np.ndarray:
    max_d = min(float(np.nanmax(r.distance_m)) for r in runs)
    if not np.isfinite(max_d) or max_d <= ds_m:
        raise ValueError("Runs do not share a usable distance overlap")
    n = max(2, int(np.floor(max_d / ds_m)) + 1)
    return np.linspace(0.0, ds_m * (n - 1), n, dtype=np.float64)


def _zscore(x: np.ndarray) -> np.ndarray:
    y = _finite_fill(x)
    sd = float(np.nanstd(y))
    if sd < 1e-9:
        return y * 0.0
    return (y - float(np.nanmean(y))) / sd


def _dtw_align_to_base(
    base_feature: np.ndarray,
    src_feature: np.ndarray,
    src_alt: np.ndarray,
) -> np.ndarray:
    if fastdtw is None or len(base_feature) < 8 or len(src_feature) < 8:
        return src_alt.copy()
    base_vec = _zscore(base_feature).reshape(-1, 1)
    src_vec = _zscore(src_feature).reshape(-1, 1)
    _, path = fastdtw(base_vec, src_vec, dist=euclidean)
    buckets: list[list[float]] = [[] for _ in range(len(base_vec))]
    for i, j in path:
        if 0 <= i < len(buckets) and 0 <= j < len(src_alt):
            v = float(src_alt[j])
            if np.isfinite(v):
                buckets[i].append(v)
    out = np.full(len(base_vec), np.nan, dtype=np.float64)
    for i, vals in enumerate(buckets):
        if vals:
            out[i] = float(np.median(vals))
    return _finite_fill(out, fill_value=float(np.nanmedian(src_alt)))


def _srvf(h: np.ndarray, ds_m: float) -> np.ndarray:
    deriv = np.gradient(_finite_fill(h), ds_m)
    return np.sign(deriv) * np.sqrt(np.abs(deriv) + 1e-12)


def _inverse_srvf(q: np.ndarray, h0: float, ds_m: float) -> np.ndarray:
    deriv = q * np.abs(q)
    return h0 + np.cumsum(deriv) * ds_m


def _karcher_mean_srvf(aligned_altitudes: np.ndarray, ds_m: float) -> np.ndarray:
    if aligned_altitudes.ndim != 2 or aligned_altitudes.shape[0] == 0:
        raise ValueError("No aligned runs for SRVF mean")
    q = np.vstack([_srvf(row, ds_m) for row in aligned_altitudes])
    mean_q = np.mean(q, axis=0)
    h0 = float(np.nanmedian(aligned_altitudes[:, 0]))
    mean_h = _inverse_srvf(mean_q, h0, ds_m)
    # SRVF recovers shape; restore vertical offset to the median aligned trace.
    median_h = np.nanmedian(aligned_altitudes, axis=0)
    offset = float(np.nanmedian(median_h - mean_h))
    return mean_h + offset


def _fit_gpr_or_smooth(distance_m: np.ndarray, mean_h: np.ndarray) -> tuple[np.ndarray, np.ndarray, str, str]:
    y = _finite_fill(mean_h)
    if GaussianProcessRegressor is None or RBF is None or WhiteKernel is None or ConstantKernel is None or len(y) < 8:
        win = min(len(y) - (1 - len(y) % 2), 31)
        smooth = savgol_filter(y, max(5, win), 2) if win >= 5 else y
        sigma = np.full_like(smooth, float(np.nanstd(y - smooth)) if len(y) else 0.0)
        return smooth, sigma, "savgol_fallback", "savgol_fallback"
    step = max(1, int(np.ceil(len(distance_m) / MAX_GPR_TRAIN_POINTS)))
    x_train = distance_m[::step].reshape(-1, 1)
    y_train = y[::step]
    span = max(float(distance_m[-1] - distance_m[0]), 1.0)
    kernel = (
        ConstantKernel(1.0, (1e-2, 1e2))
        * RBF(length_scale=max(3.0, span / 80.0), length_scale_bounds=(1.0, max(5.0, span / 2.0)))
        + WhiteKernel(noise_level=0.05, noise_level_bounds=(1e-5, 4.0))
    )
    try:
        gpr = GaussianProcessRegressor(
            kernel=kernel,
            normalize_y=True,
            alpha=1e-4,
            n_restarts_optimizer=1,
            random_state=0,
        )
        gpr.fit(x_train, y_train)
        pred, std = gpr.predict(distance_m.reshape(-1, 1), return_std=True)
        return np.asarray(pred, dtype=np.float64), np.asarray(std, dtype=np.float64), "gaussian_process_regression", str(gpr.kernel_)
    except Exception:
        win = min(len(y) - (1 - len(y) % 2), 31)
        smooth = savgol_filter(y, max(5, win), 2) if win >= 5 else y
        sigma = np.full_like(smooth, float(np.nanstd(y - smooth)) if len(y) else 0.0)
        return smooth, sigma, "savgol_fallback_after_gpr_error", "savgol_fallback_after_gpr_error"


def synthesize_canonical_reference(
    telemetry_runs: list[pd.DataFrame],
    *,
    distance_step_m: float = DEFAULT_GRID_DS_M,
) -> dict[str, Any]:
    if len(telemetry_runs) < 2:
        raise ValueError("At least two runs are required to synthesize a canonical baseline")
    ds = float(distance_step_m)
    if not np.isfinite(ds) or ds <= 0:
        raise ValueError("distance_step_m must be positive")

    fused = [_prepare_run(df) for df in telemetry_runs]
    grid = _common_grid(fused, ds)
    t_on_grid: list[np.ndarray] = []
    for df in telemetry_runs:
        t_on_grid.append(
            resample_time_on_distance_grid(
                *distance_and_time_for_delta_t(
                    df.sort_values("unix_ns").reset_index(drop=True) if "unix_ns" in df.columns else df,
                    "time_s" in df.columns,
                ),
                grid,
            )
        )
    t_mat = np.vstack(t_on_grid) if t_on_grid else np.empty((0, len(grid)))
    t_median = np.nanmedian(t_mat, axis=0) if t_mat.size else np.zeros(len(grid), dtype=np.float64)
    t_time_sigma = np.nanstd(t_mat, axis=0) if t_mat.size else np.zeros(len(grid), dtype=np.float64)

    alt_grid = np.vstack([np.interp(grid, r.distance_m, r.altitude_m) for r in fused])
    vz_grid = np.vstack([np.interp(grid, r.distance_m, r.vz_m_s) for r in fused])

    base_feature = vz_grid[0]
    aligned_alt = [alt_grid[0]]
    aligned_vz = [vz_grid[0]]
    for i in range(1, len(fused)):
        aligned_alt.append(_dtw_align_to_base(base_feature, vz_grid[i], alt_grid[i]))
        aligned_vz.append(_dtw_align_to_base(base_feature, vz_grid[i], vz_grid[i]))
    aligned = np.vstack(aligned_alt)
    aligned_vz_arr = np.vstack(aligned_vz)

    mean_shape = _karcher_mean_srvf(aligned, ds)
    canonical_h, sigma, finalizer, gpr_kernel = _fit_gpr_or_smooth(grid, mean_shape)
    canonical_vz = np.nanmedian(aligned_vz_arr, axis=0)
    if len(canonical_vz) >= 7:
        win = min(len(canonical_vz) - (1 - len(canonical_vz) % 2), 21)
        canonical_vz = savgol_filter(_finite_fill(canonical_vz), max(5, win), 2) if win >= 5 else canonical_vz
    grade = np.gradient(canonical_h, ds)
    dispersion = np.nanstd(aligned - np.nanmedian(aligned, axis=0), axis=0)
    confidence = np.sqrt(np.maximum(sigma, 0.0) ** 2 + np.maximum(dispersion, 0.0) ** 2)
    reliability = 1.0 / (1.0 + confidence)

    return {
        "distance_m": _jsonable_float_list(grid),
        "t_reference_s": _jsonable_float_list(t_median),
        "t_reference_sigma_s": _jsonable_float_list(t_time_sigma),
        "elevation_m": _jsonable_float_list(canonical_h),
        "vz_m_s": _jsonable_float_list(canonical_vz),
        "grade_m_per_m": _jsonable_float_list(grade),
        "confidence_band_m": {
            "sigma_m": _jsonable_float_list(confidence),
            "lower_m": _jsonable_float_list(canonical_h - 1.96 * confidence),
            "upper_m": _jsonable_float_list(canonical_h + 1.96 * confidence),
        },
        "reliability_score": _jsonable_float_list(reliability),
        "meta": {
            "run_count": len(fused),
            "distance_step_m": ds,
            "distance_count": int(len(grid)),
            "sample_rate_hz_by_run": [float(r.sample_rate_hz) for r in fused],
            "alignment": "fastdtw_vz_weighted" if fastdtw is not None else "identity_fallback_no_fastdtw",
            "mean_shape": "srvf_karcher_mean",
            "finalizer": finalizer,
            "gpr_kernel": gpr_kernel,
        },
    }
