"""Align GPS (low-rate) onto high-frequency baro/IMU timestamps via linear interpolation."""

from __future__ import annotations

import numpy as np
import pandas as pd


def interp_gps_to_master(
    gps: pd.DataFrame,
    master_unix_ns: np.ndarray,
) -> pd.DataFrame:
    """
    Linear interpolation of latitude, longitude, speed onto master_ns grid.
    Extrapolation outside GPS range uses edge values (constant).
    """
    g = gps.sort_values("unix_ns").drop_duplicates(subset=["unix_ns"])
    t_g = g["unix_ns"].to_numpy(dtype=np.float64)
    t_m = master_unix_ns.astype(np.float64)

    def interp(col: str, default: float = np.nan) -> np.ndarray:
        if col not in g.columns:
            return np.full(len(t_m), default, dtype=np.float64)
        y = g[col].to_numpy(dtype=np.float64)
        return np.interp(t_m, t_g, y, left=y[0] if len(y) else default, right=y[-1] if len(y) else default)

    lat = interp("latitude")
    lon = interp("longitude")
    spd = interp("speed_m_s", np.nan)
    gps_alt = interp("gps_altitude_m", np.nan)

    out = pd.DataFrame(
        {
            "unix_ns": master_unix_ns.astype(np.int64),
            "latitude": lat,
            "longitude": lon,
            "speed_m_s": spd,
            "gps_altitude_m": gps_alt,
        }
    )
    return out
