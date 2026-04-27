"""Visualization hints from full-rate processed frames (better than decimated JSON for scales)."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def _finite_f64(series: pd.Series) -> np.ndarray:
    a = series.to_numpy(dtype=np.float64, copy=False)
    return a[np.isfinite(a)]


def compute_viz_hints(proc: pd.DataFrame) -> dict[str, Any]:
    """
    Suggested map color bounds (cmin/cmax) and chart clamps from full-rate columns.
    Frontend may still override (percentile sliders); these are data-aware defaults.
    """
    out: dict[str, Any] = {"map": {}, "charts": {}}

    if "vz_m_s" in proc.columns:
        # Map / heat profile: fixed asymmetric scale (fast descent vs slight climb); spikes clip.
        out["map"]["vz"] = {"cmin": -8.0, "cmax": 1.0}
        vz_col = "vz_smooth_m_s" if "vz_smooth_m_s" in proc.columns else "vz_m_s"
        v = _finite_f64(proc[vz_col])
        av = np.abs(v)
        if av.size >= 4:
            p99 = float(np.percentile(av, 99.0))
            if np.isfinite(p99):
                half = max(2.0, min(45.0, p99 * 1.12))
                out["charts"]["vz_symmetric_half_span_m_s"] = float(half)

    return out
