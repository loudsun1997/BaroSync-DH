"""Distance-along-path indexing and delta-T between two laps (time difference at each arc length)."""

from __future__ import annotations

from typing import Any

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


def delta_t_against_reference(
    distance_m: np.ndarray,
    t_reference_s: np.ndarray,
    run: pd.DataFrame,
    *,
    use_time_s_column: bool = True,
) -> dict[str, list]:
    """
    Pace vs canonical: at each shared distance, delta_t = t_run(s) - t_ref(s).
    `distance_m` and `t_reference_s` are parallel (e.g. canonical 1m grid);
    the run is resampled onto the distances where it overlaps the reference.
    """
    g = np.asarray(distance_m, dtype=np.float64).ravel()
    tref = np.asarray(t_reference_s, dtype=np.float64).ravel()
    if len(g) < 2 or len(tref) != len(g):
        return {"distance_m": [], "delta_t_s": [], "t_a_s": [], "t_b_s": []}
    s_run, t_run = distance_and_time_for_delta_t(run, use_time_s_column)
    s_max = float(np.nanmin([np.nanmax(s_run), np.nanmax(g)]))
    if s_max <= 0 or not np.isfinite(s_max):
        return {"distance_m": [], "delta_t_s": [], "t_a_s": [], "t_b_s": []}
    inside = (g >= 0) & (g <= s_max) & np.isfinite(g) & np.isfinite(tref)
    g2 = g[inside]
    if len(g2) < 2:
        return {"distance_m": [], "delta_t_s": [], "t_a_s": [], "t_b_s": []}
    tref2 = tref[inside]
    trun2 = resample_time_on_distance_grid(s_run, t_run, g2)
    delta = trun2 - tref2
    return {
        "distance_m": g2.tolist(),
        "delta_t_s": delta.tolist(),
        "t_a_s": tref2.tolist(),
        "t_b_s": trun2.tolist(),
    }


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


def _pace_loss_pin_distances(
    dlist: np.ndarray,
    delta: np.ndarray,
    *,
    max_pins: int = 8,
) -> list[float]:
    """Largest positive Δt samples (time lost vs reference) for map pin placement."""
    if dlist.size == 0 or delta.size == 0:
        return []
    m = (delta > 0.02) & np.isfinite(dlist) & np.isfinite(delta)
    if not m.any():
        return []
    di = dlist[m]
    de = delta[m]
    order = np.argsort(-de)[:max_pins]
    return [float(di[i]) for i in order]


def build_pace_vs_reference_payload(
    run_b: pd.DataFrame,
    distance_m: np.ndarray,
    t_reference_s: np.ndarray,
    ref_elevation_m: np.ndarray,
    t_reference_sigma_s: np.ndarray | None = None,
) -> dict[str, Any]:
    """
    Full comparison object with delta_t = t_run - t_reference, lap profiles on the shared distance grid.
    `t_a_s` in delta_t is reference time; `t_b_s` is the run's time; sigma (optional) is time spread across runs
    that built the reference (per-meter), for UI bands.
    """
    g = np.asarray(distance_m, dtype=np.float64).ravel()
    h_ref = np.asarray(ref_elevation_m, dtype=np.float64).ravel()
    t_sig = None if t_reference_sigma_s is None else np.asarray(t_reference_sigma_s, dtype=np.float64).ravel()
    if len(h_ref) != len(g) or (t_sig is not None and len(t_sig) != len(g)):
        raise ValueError("ref_elevation_m and t_reference_sigma_s must match distance_m length")

    dt = delta_t_against_reference(g, t_reference_s, run_b, use_time_s_column=True)
    dlist = np.asarray(dt["distance_m"], dtype=np.float64)
    if dlist.size < 2:
        return {
            "delta_t": {**dt, "t_reference_sigma_s": None},
            "pace_vs_reference": True,
            "high_delta_distance_m": [],
            "pace_loss_distance_m": [],
            "lap_a": {"distance_m": [], "altitude_m": []},
            "lap_b": {"distance_m": [], "altitude_m": []},
        }

    s_b, h_b = altitude_vs_distance(run_b, "altitude_smooth_m")
    h_b_g = resample_time_on_distance_grid(s_b, h_b, dlist)
    d_arr = np.asarray(dt["delta_t_s"], dtype=np.float64)
    pin_d = _pace_loss_pin_distances(dlist, d_arr, max_pins=8)
    mask = high_delta_mask(d_arr, window=21, k=2.0)

    sig_resampled: list[float] | None = None
    if t_sig is not None and t_sig.size == g.size and dlist.size:
        sig_resampled = [float(t_sig[(np.abs(g - float(d))).argmin()]) for d in dlist]

    h_a_g: list[float] = []
    for d in dlist:
        j = int((np.abs(g - float(d))).argmin())
        h_a_g.append(float(h_ref[j]) if j < h_ref.size else float("nan"))

    out_dt: dict[str, Any] = {**dt, "t_reference_sigma_s": sig_resampled}
    return {
        "delta_t": out_dt,
        "pace_vs_reference": True,
        "high_delta_distance_m": dlist[mask].tolist() if dlist.size else [],
        "pace_loss_distance_m": pin_d,
        "lap_a": {"distance_m": dlist.tolist(), "altitude_m": h_a_g},
        "lap_b": {"distance_m": dlist.tolist(), "altitude_m": h_b_g.tolist()},
    }
