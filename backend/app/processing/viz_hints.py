"""Visualization hints from full-rate processed frames (better than decimated JSON for scales)."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def _finite_f64(series: pd.Series) -> np.ndarray:
    a = series.to_numpy(dtype=np.float64, copy=False)
    return a[np.isfinite(a)]


def _robust_range(
    values: np.ndarray,
    *,
    low_pct: float,
    high_pct: float,
    pad_fraction: float,
    min_span: float,
    clamp_low: float | None,
    clamp_high: float | None,
) -> tuple[float, float] | None:
    if values.size < 4:
        return None
    lo = float(np.percentile(values, low_pct))
    hi = float(np.percentile(values, high_pct))
    if not (np.isfinite(lo) and np.isfinite(hi)):
        return None
    if hi <= lo:
        mid = 0.5 * (hi + lo)
        eps = max(1e-6, abs(mid) * 1e-4)
        lo, hi = mid - eps, mid + eps
    span = hi - lo
    lo -= span * pad_fraction
    hi += span * pad_fraction
    if clamp_high is not None:
        hi = min(hi, clamp_high)
    if clamp_low is not None:
        lo = max(lo, clamp_low)
    if hi <= lo:
        mid = 0.5 * (hi + lo)
        eps = max(1e-6, abs(mid) * 1e-4)
        lo, hi = mid - eps, mid + eps
    if hi - lo < min_span:
        mid = 0.5 * (hi + lo)
        lo = mid - min_span / 2
        hi = mid + min_span / 2
    if clamp_high is not None:
        hi = min(hi, clamp_high)
    if clamp_low is not None:
        lo = max(lo, clamp_low)
    if hi <= lo:
        return None
    return (lo, hi)


def compute_viz_hints(proc: pd.DataFrame) -> dict[str, Any]:
    """
    Suggested map color bounds (cmin/cmax) and chart clamps from full-rate columns.
    Frontend may still override (percentile sliders); these are data-aware defaults.
    """
    out: dict[str, Any] = {"map": {}, "charts": {}}

    out["map"]["g"] = {"cmin": 0.5, "cmax": 4.0}

    if "vz_m_s" in proc.columns:
        v = _finite_f64(proc["vz_m_s"])
        rz = _robust_range(
            v,
            low_pct=1.0,
            high_pct=99.0,
            pad_fraction=0.14,
            min_span=8.0,
            clamp_low=-45.0,
            clamp_high=45.0,
        )
        if rz is not None:
            out["map"]["vz"] = {"cmin": rz[0], "cmax": rz[1]}
        else:
            out["map"]["vz"] = {"cmin": -14.0, "cmax": 14.0}

        av = np.abs(v)
        if av.size >= 4:
            p99 = float(np.percentile(av, 99.0))
            if np.isfinite(p99):
                half = max(2.0, min(45.0, p99 * 1.12))
                out["charts"]["vz_symmetric_half_span_m_s"] = float(half)

    return out
