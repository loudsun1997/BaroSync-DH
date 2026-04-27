"""Start-gate trim + equal-length crop + Vz FFT cross-correlation; overlap trim; virtual gate line."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from scipy.signal import correlate, correlation_lags

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
    mask = np.asarray(distance_m_a, dtype=np.float64) <= float(max_distance_m)
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
