"""Start-gate trim + equal-length crop + Vz FFT cross-correlation; overlap trim; virtual gate line."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from scipy.signal import correlate, correlation_lags
from scipy.spatial import cKDTree

from app.processing.dsp import (
    estimate_sample_rate_hz,
    savgol_smooth_series,
    vertical_velocity_m_s,
)
from app.processing.mtb_processing import apply_mtb_features
from app.processing.spatial import cumulative_distance_m, haversine_m

EARTH_R_M = 6_371_000.0


def _required_columns(df: pd.DataFrame) -> None:
    for c in ("unix_ns", "latitude", "longitude", "vz_m_s"):
        if c not in df.columns:
            raise ValueError(f"Telemetry missing required column: {c}")


def find_gate_index(
    df: pd.DataFrame,
    gate_lat: float,
    gate_lon: float,
    radius_m: float,
) -> int:
    lat = df["latitude"].to_numpy(dtype=np.float64)
    lon = df["longitude"].to_numpy(dtype=np.float64)
    d = haversine_m(
        np.full_like(lat, gate_lat, dtype=np.float64),
        np.full_like(lon, gate_lon, dtype=np.float64),
        lat,
        lon,
    )
    within = np.where(d <= radius_m)[0]
    if len(within):
        return int(within[0])
    return int(np.argmin(d))


def slice_from_gate(df: pd.DataFrame, gate_idx: int) -> pd.DataFrame:
    out = df.iloc[gate_idx:].copy().reset_index(drop=True)
    if len(out) < 2:
        return out
    lat = out["latitude"].to_numpy(dtype=np.float64)
    lon = out["longitude"].to_numpy(dtype=np.float64)
    out["distance_m"] = cumulative_distance_m(lat, lon)
    gate_ns = float(out["unix_ns"].iloc[0])
    out["time_s"] = (out["unix_ns"].astype(np.float64) - gate_ns) * 1e-9
    return out


def crop_to_min_pair_length(df_a: pd.DataFrame, df_b: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Truncate both to the same number of rows from the gate (shortest lap) to stabilize correlation and chart ends."""
    n = min(len(df_a), len(df_b))
    if n <= 0:
        return df_a.iloc[0:0].copy(), df_b.iloc[0:0].copy()
    return df_a.iloc[:n].copy().reset_index(drop=True), df_b.iloc[:n].copy().reset_index(drop=True)


def _offset_latlon_m(lat0: float, lon0: float, east_m: float, north_m: float) -> tuple[float, float]:
    dlat = (north_m / EARTH_R_M) * (180.0 / np.pi)
    dlon = (east_m / (EARTH_R_M * np.cos(np.radians(lat0)))) * (180.0 / np.pi)
    return float(lon0 + dlon), float(lat0 + dlat)


def gate_perpendicular_at_index(
    df: pd.DataFrame,
    idx: int,
    half_width_m: float = 12.0,
) -> tuple[list[float], list[float], float] | tuple[None, None, None]:
    """
    Virtual start gate: segment through snapped point `idx`, perpendicular to trail heading.

    Heading uses local tangent (east, north) from travel direction along the track toward
    increasing index. Bearing is clockwise from north: 0° = north, 90° = east — so if you
    ride north the gate runs east–west (perpendicular to motion).

    Returns (gate_line_longitude, gate_line_latitude, bearing_deg_clockwise_from_north).
    """
    n = len(df)
    if n < 2 or idx < 0 or idx >= n:
        return None, None, None
    latc = float(df["latitude"].iloc[idx])
    lonc = float(df["longitude"].iloc[idx])
    if idx < n - 1:
        i0, i1 = idx, idx + 1
    else:
        i0, i1 = idx - 1, idx
    lat0 = float(df["latitude"].iloc[i0])
    lon0 = float(df["longitude"].iloc[i0])
    lat1 = float(df["latitude"].iloc[i1])
    lon1 = float(df["longitude"].iloc[i1])
    lat_m = np.radians(0.5 * (lat0 + lat1))
    deast = EARTH_R_M * np.radians(lon1 - lon0) * np.cos(lat_m)
    dnorth = EARTH_R_M * np.radians(lat1 - lat0)
    hyp = float(np.hypot(deast, dnorth)) + 1e-9
    te, tn = deast / hyp, dnorth / hyp
    bearing_deg = float(np.degrees(np.arctan2(deast, dnorth)))
    pe, pn = -tn, te
    lon_a, lat_a = _offset_latlon_m(latc, lonc, -pe * half_width_m, -pn * half_width_m)
    lon_b, lat_b = _offset_latlon_m(latc, lonc, pe * half_width_m, pn * half_width_m)
    return [lon_a, lon_b], [lat_a, lat_b], bearing_deg


def vz_segments_for_correlation(
    va: np.ndarray,
    vb: np.ndarray,
    distance_m_a: np.ndarray,
    max_distance_m: float,
    min_samples: int = 32,
) -> tuple[np.ndarray, np.ndarray]:
    """Use only samples where Run A is within max_distance_m of the gate (initial sync window)."""
    n = min(len(va), len(vb), len(distance_m_a))
    va = np.asarray(va, dtype=np.float64)[:n]
    vb = np.asarray(vb, dtype=np.float64)[:n]
    distance_m_a = np.asarray(distance_m_a, dtype=np.float64)[:n]
    mask = distance_m_a <= float(max_distance_m)
    if int(np.sum(mask)) >= min_samples:
        return va[mask], vb[mask]
    return va, vb


def vz_lag_equal_length_fft(
    va: np.ndarray,
    vb: np.ndarray,
    dt_run_b_s: float,
) -> tuple[float, float, int]:
    """
    FFT cross-correlation of equal-length demeaned Vz.
    Returns (lag_seconds to add to Run B time_s, normalized_peak, lag_samples).
    """
    va = np.nan_to_num(np.asarray(va, dtype=np.float64), nan=0.0)
    vb = np.nan_to_num(np.asarray(vb, dtype=np.float64), nan=0.0)
    n = min(len(va), len(vb))
    if n < 8:
        return 0.0, 0.0, 0
    va = va[:n]
    vb = vb[:n]
    va0 = va - float(np.mean(va))
    vb0 = vb - float(np.mean(vb))
    std = float(np.std(va0) * np.std(vb0)) + 1e-12
    c = correlate(va0, vb0, mode="full", method="fft")
    lags = correlation_lags(len(va0), len(vb0), mode="full")
    ibest = int(np.argmax(c))
    lag_samples = int(lags[ibest])
    dt_b = max(float(dt_run_b_s), 1.0 / 500.0)
    lag_s = lag_samples * dt_b
    peak = float(c[ibest] / (n * std))
    return lag_s, peak, lag_samples


def trim_vz_edges(df: pd.DataFrame, vz_eps: float = 0.03) -> pd.DataFrame:
    """Drop leading/trailing samples where |Vz| is near zero (stops chart spikes)."""
    if len(df) < 4 or "vz_m_s" not in df.columns:
        return df
    v = np.abs(df["vz_m_s"].to_numpy(dtype=np.float64))
    ok = np.isfinite(v) & (v > vz_eps)
    if not ok.any():
        return df
    idx = np.flatnonzero(ok)
    lo, hi = int(idx[0]), int(idx[-1]) + 1
    out = df.iloc[lo:hi].copy().reset_index(drop=True)
    if len(out) < 2:
        return out
    lat = out["latitude"].to_numpy(dtype=np.float64)
    lon = out["longitude"].to_numpy(dtype=np.float64)
    out["distance_m"] = cumulative_distance_m(lat, lon)
    gate_ns = float(out["unix_ns"].iloc[0])
    out["time_s"] = (out["unix_ns"].astype(np.float64) - gate_ns) * 1e-9
    return out


def slice_overlap_distance(df_a: pd.DataFrame, df_b: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    if len(df_a) < 2 or len(df_b) < 2:
        return df_a, df_b
    da = df_a["distance_m"].to_numpy(dtype=np.float64)
    db = df_b["distance_m"].to_numpy(dtype=np.float64)
    d_max = float(min(np.nanmax(da), np.nanmax(db)))
    if not np.isfinite(d_max) or d_max <= 0:
        return df_a.iloc[0:0].copy(), df_b.iloc[0:0].copy()
    a2 = df_a[df_a["distance_m"] <= d_max].copy().reset_index(drop=True)
    b2 = df_b[df_b["distance_m"] <= d_max].copy().reset_index(drop=True)
    return a2, b2


def _latlon_to_local_xy_m(
    lat: np.ndarray,
    lon: np.ndarray,
    lat0: float,
    lon0: float,
) -> np.ndarray:
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    x = EARTH_R_M * np.radians(lon - lon0) * np.cos(np.radians(lat0))
    y = EARTH_R_M * np.radians(lat - lat0)
    return np.column_stack([x, y])


def _distance_column_or_compute(df: pd.DataFrame) -> np.ndarray:
    if "distance_m" in df.columns:
        d = df["distance_m"].to_numpy(dtype=np.float64)
        if len(d) == len(df) and np.isfinite(d).any():
            return d
    return cumulative_distance_m(
        df["latitude"].to_numpy(dtype=np.float64),
        df["longitude"].to_numpy(dtype=np.float64),
    )


def _spatial_samples(df: pd.DataFrame, step_m: float = 1.0) -> pd.DataFrame:
    """One representative row per travelled-distance bin, preserving original row index."""
    use = df[["latitude", "longitude"]].copy()
    use["orig_index"] = np.arange(len(df), dtype=np.int64)
    use["distance_m"] = _distance_column_or_compute(df)
    use = use.replace([np.inf, -np.inf], np.nan).dropna(subset=["latitude", "longitude", "distance_m"])
    use = use[use["distance_m"] >= 0].copy()
    if use.empty:
        return use
    bins = np.floor(use["distance_m"].to_numpy(dtype=np.float64) / max(float(step_m), 0.25))
    use["distance_bin"] = bins.astype(np.int64)
    return use.drop_duplicates("distance_bin", keep="first").reset_index(drop=True)


def _best_monotonic_match_group(
    matches: pd.DataFrame,
    *,
    min_overlap_m: float,
    max_gap_m: float,
    max_backtrack_m: float,
) -> pd.DataFrame:
    best: pd.DataFrame | None = None
    start = 0
    rows = matches.reset_index(drop=True)
    for i in range(1, len(rows) + 1):
        split = i == len(rows)
        if not split:
            da = float(rows.loc[i, "a_distance_m"] - rows.loc[i - 1, "a_distance_m"])
            db = float(rows.loc[i, "b_distance_m"] - rows.loc[i - 1, "b_distance_m"])
            split = da > max_gap_m or db < -max_backtrack_m or db > max_gap_m * 4.0
        if split:
            group = rows.iloc[start:i].copy()
            if len(group) >= 2:
                span_a = float(group["a_distance_m"].iloc[-1] - group["a_distance_m"].iloc[0])
                span_b = float(group["b_distance_m"].iloc[-1] - group["b_distance_m"].iloc[0])
                if span_a >= min_overlap_m and span_b >= min_overlap_m:
                    if best is None:
                        best = group
                    else:
                        best_span = float(best["a_distance_m"].iloc[-1] - best["a_distance_m"].iloc[0])
                        if span_a > best_span:
                            best = group
            start = i
    if best is None:
        raise ValueError("Could not find a sustained shared route segment between the two runs")
    return best


def find_shared_corridor_indices(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    *,
    radius_m: float = 12.0,
    sample_step_m: float = 1.0,
    min_overlap_m: float = 50.0,
    max_gap_m: float = 35.0,
) -> dict[str, Any]:
    """
    Find the longest same-direction corridor where the two GPS tracks overlap.

    This replaces the manual map start gate. It samples each processed track by
    travelled distance, nearest-neighbor matches Run A to Run B in local meters,
    then chooses the longest monotonic shared segment. The first and last matches
    become the automatic start/end trim points.
    """
    if len(df_a) < 2 or len(df_b) < 2:
        raise ValueError("Need at least two samples per run for automatic shared-route detection")

    sa = _spatial_samples(df_a, step_m=sample_step_m)
    sb = _spatial_samples(df_b, step_m=sample_step_m)
    if len(sa) < 2 or len(sb) < 2:
        raise ValueError("Not enough valid GPS samples for automatic shared-route detection")

    lat0 = float(pd.concat([sa["latitude"], sb["latitude"]]).median())
    lon0 = float(pd.concat([sa["longitude"], sb["longitude"]]).median())
    xy_a = _latlon_to_local_xy_m(
        sa["latitude"].to_numpy(dtype=np.float64),
        sa["longitude"].to_numpy(dtype=np.float64),
        lat0,
        lon0,
    )
    xy_b = _latlon_to_local_xy_m(
        sb["latitude"].to_numpy(dtype=np.float64),
        sb["longitude"].to_numpy(dtype=np.float64),
        lat0,
        lon0,
    )

    d_near, j_near = cKDTree(xy_b).query(xy_a, k=1)
    keep = np.isfinite(d_near) & (d_near <= radius_m)
    if int(np.sum(keep)) < 2:
        raise ValueError(f"Runs never come within {radius_m:.1f} m of each other")

    kept_a = sa.loc[keep].reset_index(drop=True)
    kept_b = sb.iloc[j_near[keep]].reset_index(drop=True)
    matches = pd.DataFrame(
        {
            "a_index": kept_a["orig_index"].to_numpy(dtype=np.int64),
            "b_index": kept_b["orig_index"].to_numpy(dtype=np.int64),
            "a_distance_m": kept_a["distance_m"].to_numpy(dtype=np.float64),
            "b_distance_m": kept_b["distance_m"].to_numpy(dtype=np.float64),
            "nearest_distance_m": d_near[keep].astype(np.float64),
        }
    ).sort_values(["a_distance_m", "b_distance_m"]).reset_index(drop=True)

    best = _best_monotonic_match_group(
        matches,
        min_overlap_m=min_overlap_m,
        max_gap_m=max_gap_m,
        max_backtrack_m=max(8.0, radius_m),
    )
    return {
        "start_index_a": int(best["a_index"].iloc[0]),
        "start_index_b": int(best["b_index"].iloc[0]),
        "end_index_a": int(best["a_index"].iloc[-1]),
        "end_index_b": int(best["b_index"].iloc[-1]),
        "overlap_distance_m_a": float(best["a_distance_m"].iloc[-1] - best["a_distance_m"].iloc[0]),
        "overlap_distance_m_b": float(best["b_distance_m"].iloc[-1] - best["b_distance_m"].iloc[0]),
        "nearest_distance_median": float(best["nearest_distance_m"].median()),
        "nearest_distance_p95": float(best["nearest_distance_m"].quantile(0.95)),
        "match_count": int(len(best)),
        "search_radius_m": float(radius_m),
    }


def slice_between_indices(df: pd.DataFrame, start_idx: int, end_idx: int) -> pd.DataFrame:
    lo = max(0, min(int(start_idx), int(end_idx)))
    hi = min(len(df), max(int(start_idx), int(end_idx)) + 1)
    out = df.iloc[lo:hi].copy().reset_index(drop=True)
    if len(out) < 2:
        return out
    out["distance_m"] = cumulative_distance_m(
        out["latitude"].to_numpy(dtype=np.float64),
        out["longitude"].to_numpy(dtype=np.float64),
    )
    t0 = float(out["unix_ns"].iloc[0])
    out["time_s"] = (out["unix_ns"].astype(np.float64) - t0) * 1e-9
    return out


def _altitude_column(df: pd.DataFrame) -> str | None:
    for col in ("altitude_smooth_m", "altitude_m", "relative_altitude_app_m"):
        if col in df.columns:
            return col
    return None


def _slice_from_distance(df: pd.DataFrame, start_m: float, end_m: float | None = None) -> pd.DataFrame:
    if len(df) < 2 or "distance_m" not in df.columns:
        return df
    d = df["distance_m"].to_numpy(dtype=np.float64)
    if not np.isfinite(d).any():
        return df
    start_idx = int(np.searchsorted(d, max(float(start_m), 0.0), side="left"))
    if end_m is None:
        end_idx = len(df)
    else:
        end_idx = int(np.searchsorted(d, float(end_m), side="right"))
    start_idx = max(0, min(start_idx, len(df) - 1))
    end_idx = max(start_idx + 2, min(end_idx, len(df)))
    out = df.iloc[start_idx:end_idx].copy().reset_index(drop=True)
    if len(out) < 2:
        return out
    out["distance_m"] = cumulative_distance_m(
        out["latitude"].to_numpy(dtype=np.float64),
        out["longitude"].to_numpy(dtype=np.float64),
    )
    t0 = float(out["unix_ns"].iloc[0])
    out["time_s"] = (out["unix_ns"].astype(np.float64) - t0) * 1e-9
    return out


def _rolling_median(x: np.ndarray, window: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if len(x) == 0:
        return x
    window = max(1, int(window))
    half = window // 2
    out = np.empty(len(x), dtype=np.float64)
    for i in range(len(x)):
        lo = max(0, i - half)
        hi = min(len(x), i + half + 1)
        out[i] = float(np.nanmedian(x[lo:hi]))
    return out


def trim_to_baro_agreement(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    *,
    grid_step_m: float = 1.0,
    window_m: float = 25.0,
    sustain_m: float = 35.0,
    residual_threshold_m: float = 5.0,
    min_keep_m: float = 80.0,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """
    Tighten the GPS overlap using altitude-shape agreement.

    GPS can say two runs share the same trail before their barometer tracks have
    settled. We compare altitude difference against the stable offset found in
    the latter overlap, then skip the leading section until the residual stays
    small for a sustained distance.
    """
    alt_col_a = _altitude_column(df_a)
    alt_col_b = _altitude_column(df_b)
    meta: dict[str, Any] = {
        "baro_agreement_applied": False,
        "baro_agreement_start_trim_m": 0.0,
        "baro_agreement_end_distance_m": None,
    }
    if alt_col_a is None or alt_col_b is None or len(df_a) < 4 or len(df_b) < 4:
        meta["baro_agreement_reason"] = "missing_altitude"
        return df_a, df_b, meta

    max_dist = float(
        min(
            np.nanmax(df_a["distance_m"].to_numpy(dtype=np.float64)),
            np.nanmax(df_b["distance_m"].to_numpy(dtype=np.float64)),
        )
    )
    if not np.isfinite(max_dist) or max_dist < max(min_keep_m, sustain_m + window_m):
        meta["baro_agreement_reason"] = "overlap_too_short"
        return df_a, df_b, meta

    grid = np.arange(0.0, max_dist + 0.5 * grid_step_m, max(float(grid_step_m), 0.25), dtype=np.float64)
    da = df_a["distance_m"].to_numpy(dtype=np.float64)
    db = df_b["distance_m"].to_numpy(dtype=np.float64)
    ha = df_a[alt_col_a].to_numpy(dtype=np.float64)
    hb = df_b[alt_col_b].to_numpy(dtype=np.float64)
    mask_a = np.isfinite(da) & np.isfinite(ha)
    mask_b = np.isfinite(db) & np.isfinite(hb)
    if int(np.sum(mask_a)) < 4 or int(np.sum(mask_b)) < 4:
        meta["baro_agreement_reason"] = "not_enough_altitude"
        return df_a, df_b, meta

    ha_grid = np.interp(grid, da[mask_a], ha[mask_a])
    hb_grid = np.interp(grid, db[mask_b], hb[mask_b])
    diff = ha_grid - hb_grid
    tail_start = int(len(diff) * 0.45)
    stable_offset = float(np.nanmedian(diff[tail_start:]))
    residual = np.abs(diff - stable_offset)
    window_n = max(3, int(round(window_m / max(float(grid_step_m), 0.25))))
    sustain_n = max(3, int(round(sustain_m / max(float(grid_step_m), 0.25))))
    smooth_residual = _rolling_median(residual, window_n)
    ok = np.isfinite(smooth_residual) & (smooth_residual <= float(residual_threshold_m))

    start_idx = 0
    for i in range(0, max(1, len(ok) - sustain_n + 1)):
        if bool(np.all(ok[i : i + sustain_n])):
            start_idx = i
            break

    if start_idx == 0:
        meta.update(
            {
                "baro_agreement_applied": False,
                "baro_agreement_reason": "already_agrees",
                "baro_agreement_stable_offset_m": stable_offset,
                "baro_agreement_residual_threshold_m": float(residual_threshold_m),
                "baro_agreement_initial_residual_m": float(smooth_residual[0]),
            }
        )
        return df_a, df_b, meta

    trim_m = float(grid[start_idx])
    if max_dist - trim_m < min_keep_m:
        meta.update(
            {
                "baro_agreement_applied": False,
                "baro_agreement_reason": "trim_would_leave_too_little",
                "baro_agreement_candidate_trim_m": trim_m,
                "baro_agreement_stable_offset_m": stable_offset,
            }
        )
        return df_a, df_b, meta

    a2 = _slice_from_distance(df_a, trim_m)
    b2 = _slice_from_distance(df_b, trim_m)
    meta.update(
        {
            "baro_agreement_applied": True,
            "baro_agreement_reason": "leading_altitude_disagreement",
            "baro_agreement_start_trim_m": trim_m,
            "baro_agreement_stable_offset_m": stable_offset,
            "baro_agreement_residual_threshold_m": float(residual_threshold_m),
            "baro_agreement_initial_residual_m": float(smooth_residual[0]),
            "baro_agreement_residual_at_start_m": float(smooth_residual[start_idx]),
        }
    )
    return a2, b2, meta


def align_runs_auto_shared_baro(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    *,
    shared_radius_m: float = 12.0,
    vz_edge_eps: float = 0.03,
    correlation_max_distance_m: float = 100.0,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """
    Auto-trim to the shared GPS corridor, then apply the existing Vz lag sync.
    """
    _required_columns(df_a)
    _required_columns(df_b)
    shared = find_shared_corridor_indices(df_a, df_b, radius_m=shared_radius_m)

    ia = int(shared["start_index_a"])
    ib = int(shared["start_index_b"])
    enda = int(shared["end_index_a"])
    endb = int(shared["end_index_b"])

    a = slice_between_indices(df_a, ia, enda)
    b = slice_between_indices(df_b, ib, endb)
    if len(a) < 10 or len(b) < 10:
        raise ValueError("Too few samples after automatic shared-route trim")

    a_pre_agreement = a
    b_pre_agreement = b
    a, b, baro_agreement = trim_to_baro_agreement(a, b)
    if len(a) < 10 or len(b) < 10:
        raise ValueError("Too few samples after automatic baro-agreement trim")

    if baro_agreement.get("baro_agreement_applied"):
        trim_m = float(baro_agreement["baro_agreement_start_trim_m"])
        ia = int(ia + np.searchsorted(a_pre_agreement["distance_m"].to_numpy(dtype=np.float64), trim_m))
        ib = int(ib + np.searchsorted(b_pre_agreement["distance_m"].to_numpy(dtype=np.float64), trim_m))

    gate_lons, gate_lats, bearing_a = gate_perpendicular_at_index(df_a, ia, half_width_m=12.0)

    ns_b = b["unix_ns"].to_numpy(dtype=np.float64)
    dts = np.diff(ns_b) * 1e-9
    dts = dts[np.isfinite(dts) & (dts > 0)]
    dt_b = float(np.median(dts)) if len(dts) else (1.0 / 25.0)

    va = a["vz_m_s"].to_numpy(dtype=np.float64)
    vb = b["vz_m_s"].to_numpy(dtype=np.float64)
    va_corr, vb_corr = vz_segments_for_correlation(
        va,
        vb,
        a["distance_m"].to_numpy(dtype=np.float64),
        max_distance_m=correlation_max_distance_m,
        min_samples=32,
    )
    lag_s, peak, lag_samples = vz_lag_equal_length_fft(va_corr, vb_corr, dt_b)

    b = b.copy()
    b["time_s"] = b["time_s"].to_numpy(dtype=np.float64) + lag_s

    a = trim_vz_edges(a, vz_edge_eps)
    b = trim_vz_edges(b, vz_edge_eps)
    a, b = slice_overlap_distance(a, b)

    fs_a = estimate_sample_rate_hz(a["unix_ns"].to_numpy())
    fs_b = estimate_sample_rate_hz(b["unix_ns"].to_numpy())
    a = apply_mtb_features(a, fs_a)
    b = apply_mtb_features(b, fs_b)

    meta: dict[str, Any] = {
        "alignment_method": "auto_shared_corridor_baro",
        "gate_index_a": ia,
        "gate_index_b": ib,
        "end_index_a": enda,
        "end_index_b": endb,
        "baro_correlation_distance_m": float(correlation_max_distance_m),
        "baro_correlation_samples_used": int(len(va_corr)),
        "cropped_length_samples": int(min(len(a), len(b))),
        "lag_samples_run_b": lag_samples,
        "median_dt_run_b_s": dt_b,
        "lag_applied_to_run_b_s": lag_s,
        "correlation_peak_normalized": peak,
        "gate_latitude": float(df_a["latitude"].iloc[ia]),
        "gate_longitude": float(df_a["longitude"].iloc[ia]),
        "gate_radius_m": float(shared_radius_m),
        "gate_snapped_latitude_a": float(df_a["latitude"].iloc[ia]),
        "gate_snapped_longitude_a": float(df_a["longitude"].iloc[ia]),
        "gate_snapped_latitude_b": float(df_b["latitude"].iloc[ib]),
        "gate_snapped_longitude_b": float(df_b["longitude"].iloc[ib]),
        "shared_route": shared,
        "baro_agreement": baro_agreement,
    }
    if bearing_a is not None:
        meta["trail_bearing_deg_clockwise_from_north_a"] = bearing_a
    if gate_lons is not None and gate_lats is not None:
        meta["gate_line_longitude"] = gate_lons
        meta["gate_line_latitude"] = gate_lats
    return a, b, meta


def align_runs_at_gate_baro(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    gate_lat: float,
    gate_lon: float,
    gate_radius_m: float = 20.0,
    vz_edge_eps: float = 0.03,
    correlation_max_distance_m: float = 100.0,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """
    1) Gate slice: T=0, distance 0 at gate (spatial anchor ~20 m).
    2) Crop both to min(length) — same sample count from the start, kills tail mismatch spikes.
    3) FFT correlate Vz on the first ``correlation_max_distance_m`` on Run A only; lag × Run B Δt → add to all of Run B time_s.
    4) Trim low-|Vz| edges; slice to shared distance.
    """
    _required_columns(df_a)
    _required_columns(df_b)

    ia = find_gate_index(df_a, gate_lat, gate_lon, gate_radius_m)
    ib = find_gate_index(df_b, gate_lat, gate_lon, gate_radius_m)
    a = slice_from_gate(df_a, ia)
    b = slice_from_gate(df_b, ib)

    a, b = crop_to_min_pair_length(a, b)
    n_common = len(a)

    gate_lons, gate_lats, bearing_a = gate_perpendicular_at_index(df_a, ia, half_width_m=12.0)

    ns_b = b["unix_ns"].to_numpy(dtype=np.float64)
    dts = np.diff(ns_b) * 1e-9
    dts = dts[np.isfinite(dts) & (dts > 0)]
    dt_b = float(np.median(dts)) if len(dts) else (1.0 / 25.0)

    va = a["vz_m_s"].to_numpy(dtype=np.float64)
    vb = b["vz_m_s"].to_numpy(dtype=np.float64)
    d_sync = a["distance_m"].to_numpy(dtype=np.float64)
    va_corr, vb_corr = vz_segments_for_correlation(
        va, vb, d_sync, max_distance_m=correlation_max_distance_m, min_samples=32
    )
    lag_s, peak, lag_samples = vz_lag_equal_length_fft(va_corr, vb_corr, dt_b)

    b = b.copy()
    b["time_s"] = b["time_s"].to_numpy(dtype=np.float64) + lag_s

    a = trim_vz_edges(a, vz_edge_eps)
    b = trim_vz_edges(b, vz_edge_eps)
    a, b = slice_overlap_distance(a, b)

    meta: dict[str, Any] = {
        "gate_index_a": ia,
        "gate_index_b": ib,
        "baro_correlation_distance_m": float(correlation_max_distance_m),
        "baro_correlation_samples_used": int(len(va_corr)),
        "cropped_length_samples": n_common,
        "lag_samples_run_b": lag_samples,
        "median_dt_run_b_s": dt_b,
        "lag_applied_to_run_b_s": lag_s,
        "correlation_peak_normalized": peak,
        "gate_latitude": gate_lat,
        "gate_longitude": gate_lon,
        "gate_radius_m": gate_radius_m,
        "gate_snapped_latitude_a": float(df_a["latitude"].iloc[ia]),
        "gate_snapped_longitude_a": float(df_a["longitude"].iloc[ia]),
        "gate_snapped_latitude_b": float(df_b["latitude"].iloc[ib]),
        "gate_snapped_longitude_b": float(df_b["longitude"].iloc[ib]),
    }
    if bearing_a is not None:
        meta["trail_bearing_deg_clockwise_from_north_a"] = bearing_a
    if gate_lons is not None and gate_lats is not None:
        meta["gate_line_longitude"] = gate_lons
        meta["gate_line_latitude"] = gate_lats

    fs_a = estimate_sample_rate_hz(a["unix_ns"].to_numpy())
    fs_b = estimate_sample_rate_hz(b["unix_ns"].to_numpy())
    a = apply_mtb_features(a, fs_a)
    b = apply_mtb_features(b, fs_b)

    return a, b, meta


TelemetryPayload = list[dict[str, Any]] | dict[str, list[Any]]


def _inject_vz_m_s_for_alignment_if_missing(df: pd.DataFrame) -> pd.DataFrame:
    """
    /upload no longer includes vz in JSON; align-baro reposts that payload. Re-derive
    Vz from exported altitude (same path as a lightweight pipeline slice).
    """
    if "vz_m_s" in df.columns:
        return df
    alt: np.ndarray | None = None
    for col in ("altitude_smooth_m", "altitude_m", "relative_altitude_app_m"):
        if col in df.columns:
            alt = df[col].to_numpy(dtype=np.float64)
            break
    if alt is None or len(alt) < 2:
        raise ValueError("Missing vz_m_s: need altitude_smooth_m, altitude_m, or relative_altitude_app_m")
    ns = df["unix_ns"].to_numpy(dtype=np.float64)
    fs = float(estimate_sample_rate_hz(ns))
    if not (np.isfinite(fs) and fs > 0):
        raise ValueError("Invalid sample rate; cannot derive vz_m_s for alignment")
    vz = vertical_velocity_m_s(alt, ns)
    out = df.copy()
    out["vz_m_s"] = savgol_smooth_series(vz, fs_hz=fs, window_s=0.55, polyorder=2)
    return out


def telemetry_payload_to_dataframe(
    payload: TelemetryPayload,
    *,
    require_vz: bool = True,
) -> pd.DataFrame:
    """Build a DataFrame from row records or a column-oriented dict (same JSON the pipeline emits)."""
    if isinstance(payload, list):
        df = pd.DataFrame(payload)
    elif isinstance(payload, dict):
        if not payload:
            raise ValueError("Empty telemetry")
        df = pd.DataFrame(payload)
    else:
        raise ValueError("Telemetry must be a JSON array of records or a column-oriented object")
    if df.empty:
        raise ValueError("Empty telemetry")
    for col in ("unix_ns", "latitude", "longitude"):
        if col not in df.columns:
            raise ValueError(f"Missing {col}")
    if require_vz:
        df = _inject_vz_m_s_for_alignment_if_missing(df)
    return df.sort_values("unix_ns").reset_index(drop=True)


def telemetry_records_to_dataframe(records: TelemetryPayload) -> pd.DataFrame:
    return telemetry_payload_to_dataframe(records, require_vz=True)


def build_comparison_payload(a: pd.DataFrame, b: pd.DataFrame, ds_m: float = 1.0) -> dict[str, Any]:
    from app.processing.compare import altitude_vs_distance, delta_t_along_path, high_delta_mask

    dt = delta_t_along_path(a, b, ds_m=ds_m, use_time_s_column=True)
    sa, ha = altitude_vs_distance(a, "altitude_smooth_m")
    sb, hb = altitude_vs_distance(b, "altitude_smooth_m")
    mask = high_delta_mask(np.asarray(dt["delta_t_s"], dtype=np.float64))
    return {
        "delta_t": dt,
        "high_delta_distance_m": np.asarray(dt["distance_m"])[mask].tolist(),
        "lap_a": {"distance_m": sa.tolist(), "altitude_m": ha.tolist()},
        "lap_b": {"distance_m": sb.tolist(), "altitude_m": hb.tolist()},
    }
