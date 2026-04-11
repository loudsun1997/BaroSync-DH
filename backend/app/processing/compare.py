"""Distance-along-path indexing and delta-T between two laps (time difference at each arc length)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from app.processing.spatial import cumulative_distance_m


def time_vs_distance(
    unix_ns: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Returns (distance_m along path, time_s from first sample)."""
    s = cumulative_distance_m(lat, lon)
    t0 = float(unix_ns[0]) * 1e-9
    t_s = unix_ns.astype(np.float64) * 1e-9 - t0
    return s, t_s


def distance_and_time_for_delta_t(
    run: pd.DataFrame,
    use_time_s_column: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """Distance along GPS path; time uses aligned time_s when requested (baro gate + lag)."""
    lat = run["latitude"].to_numpy(dtype=np.float64)
    lon = run["longitude"].to_numpy(dtype=np.float64)
    s = cumulative_distance_m(lat, lon)
    if use_time_s_column and "time_s" in run.columns:
        t_s = run["time_s"].to_numpy(dtype=np.float64)
    else:
        ns = run["unix_ns"].to_numpy(dtype=np.float64)
        t0 = float(ns[0]) * 1e-9
        t_s = ns * 1e-9 - t0
    return s, t_s


def resample_time_on_distance_grid(
    s: np.ndarray,
    t_s: np.ndarray,
    grid_s: np.ndarray,
) -> np.ndarray:
    """Monotonic interpolation: time as function of distance (handle non-monotonic s with sort)."""
    order = np.argsort(s)
    s_sorted = s[order]
    t_sorted = t_s[order]
    # collapse duplicate s
    uniq_s: list[float] = []
    uniq_t: list[float] = []
    for si, ti in zip(s_sorted, t_sorted):
        if uniq_s and si == uniq_s[-1]:
            uniq_t[-1] = ti
        else:
            uniq_s.append(float(si))
            uniq_t.append(float(ti))
    s_u = np.asarray(uniq_s)
    t_u = np.asarray(uniq_t)
    return np.interp(grid_s, s_u, t_u, left=t_u[0], right=t_u[-1])


def delta_t_along_path(
    run_a: pd.DataFrame,
    run_b: pd.DataFrame,
    ds_m: float = 1.0,
    *,
    use_time_s_column: bool = False,
) -> dict[str, list]:
    """
    At each meter (or ds_m), delta_t = t_B(s) - t_A(s), both aligned to distance from start.
    With use_time_s_column=True, uses time_s (e.g. after start gate + baro lag on Run B).
    """
    sa, ta = distance_and_time_for_delta_t(run_a, use_time_s_column)
    sb, tb = distance_and_time_for_delta_t(run_b, use_time_s_column)
    s_max = float(min(sa.max(), sb.max()))
    if s_max <= 0 or not np.isfinite(s_max):
        return {"distance_m": [], "delta_t_s": [], "t_a_s": [], "t_b_s": []}
    grid = np.arange(0.0, s_max, ds_m, dtype=np.float64)
    t_a_g = resample_time_on_distance_grid(sa, ta, grid)
    t_b_g = resample_time_on_distance_grid(sb, tb, grid)
    delta = t_b_g - t_a_g
    return {
        "distance_m": grid.tolist(),
        "delta_t_s": delta.tolist(),
        "t_a_s": t_a_g.tolist(),
        "t_b_s": t_b_g.tolist(),
    }


def altitude_vs_distance(
    df: pd.DataFrame,
    alt_col: str = "altitude_smooth_m",
) -> tuple[np.ndarray, np.ndarray]:
    s = cumulative_distance_m(df["latitude"].to_numpy(), df["longitude"].to_numpy())
    if alt_col not in df.columns:
        alt_col = "altitude_m"
    h = df[alt_col].to_numpy(dtype=np.float64)
    return s, h


def high_delta_mask(delta_t_s: np.ndarray, window: int = 21, k: float = 2.0) -> np.ndarray:
    """Flag segments where |d(delta_t)/ds| is large (cornering / pace changes)."""
    d = np.asarray(delta_t_s, dtype=np.float64)
    if len(d) < window:
        return np.zeros(len(d), dtype=bool)
    dd = np.abs(np.gradient(d))
    roll = np.convolve(dd, np.ones(window) / window, mode="same")
    med = np.nanmedian(roll)
    mad = np.nanmedian(np.abs(roll - med)) + 1e-9
    return roll > (med + k * mad)
