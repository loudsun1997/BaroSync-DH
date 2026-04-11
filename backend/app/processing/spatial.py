"""Haversine distance, cumulative path length, GPS outlier handling."""

from __future__ import annotations

import numpy as np
import pandas as pd

EARTH_R_M = 6_371_000.0


def haversine_m(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    """Great-circle distance in meters (vectorized)."""
    p1 = np.radians(lat1)
    p2 = np.radians(lat2)
    dlat = np.radians(lat2 - lat1)
    dlon = np.radians(lon2 - lon1)
    a = np.sin(dlat / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlon / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(np.maximum(0.0, 1.0 - a)))
    return EARTH_R_M * c


def cumulative_distance_m(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    if len(lat) < 2:
        return np.zeros_like(lat, dtype=np.float64)
    d = np.zeros(len(lat), dtype=np.float64)
    d[1:] = haversine_m(lat[:-1], lon[:-1], lat[1:], lon[1:])
    return np.cumsum(d)


def align_two_processed_runs(
    a: pd.DataFrame,
    b: pd.DataFrame,
    radius_m: float = 5.0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Trim both runs so distance 0 is the first moment they pass within radius_m of each other
    (search along run A, then trim B at closest index). Resets distance_m and time_s from trim.
    """
    if len(a) < 2 or len(b) < 2:
        return a, b
    la = a["latitude"].to_numpy(dtype=np.float64)
    loa = a["longitude"].to_numpy(dtype=np.float64)
    lb = b["latitude"].to_numpy(dtype=np.float64)
    lob = b["longitude"].to_numpy(dtype=np.float64)
    for i in range(len(a)):
        dmin = float(np.min(haversine_m(la[i], loa[i], lb, lob)))
        if dmin <= radius_m:
            j = int(np.argmin(haversine_m(la[i], loa[i], lb, lob)))
            a2 = a.iloc[i:].copy().reset_index(drop=True)
            b2 = b.iloc[j:].copy().reset_index(drop=True)
            t0a = float(a2["unix_ns"].iloc[0])
            t0b = float(b2["unix_ns"].iloc[0])
            a2["distance_m"] = cumulative_distance_m(
                a2["latitude"].to_numpy(), a2["longitude"].to_numpy()
            )
            b2["distance_m"] = cumulative_distance_m(
                b2["latitude"].to_numpy(), b2["longitude"].to_numpy()
            )
            a2["time_s"] = (a2["unix_ns"].astype(np.float64) - t0a) * 1e-9
            b2["time_s"] = (b2["unix_ns"].astype(np.float64) - t0b) * 1e-9
            return a2, b2
    return a, b


def filter_gps_outliers(
    df: pd.DataFrame,
    accuracy_max_m: float = 75.0,
    z_step_threshold: float = 3.0,
) -> pd.DataFrame:
    """
    Drop GPS fixes with poor reported accuracy and large position jumps (z-score on step distance).
    Consumer / trail GPS often reports >5 m accuracy; default cap is relaxed. If that would remove
    nearly all fixes, accuracy filtering is skipped and only step-outlier logic runs.
    """
    out = df.copy()
    if "horizontal_accuracy_m" in out.columns:
        acc_ok = out["horizontal_accuracy_m"].isna() | (out["horizontal_accuracy_m"] <= accuracy_max_m)
        filtered = out[acc_ok]
        if len(filtered) >= 2:
            out = filtered
    if len(out) < 3:
        return out.reset_index(drop=True)
    lat = out["latitude"].to_numpy()
    lon = out["longitude"].to_numpy()
    steps = np.zeros(len(out))
    steps[1:] = haversine_m(lat[:-1], lon[:-1], lat[1:], lon[1:])
    mu = np.nanmean(steps[1:])
    sigma = np.nanstd(steps[1:])
    if sigma > 1e-6:
        z = np.abs((steps - mu) / sigma)
        z[0] = 0.0
        out = out[z <= z_step_threshold]
    return out.reset_index(drop=True)
