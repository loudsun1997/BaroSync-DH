"""Butterworth low-pass, Bernoulli pressure correction, vertical velocity, cubic spline smoothing."""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.interpolate import CubicSpline
from scipy.signal import butter, filtfilt, savgol_filter

from app.processing.constants import STANDARD_GRAVITY_MS2, hypsometric_altitude_m


def butterworth_lowpass(
    y: np.ndarray,
    fs_hz: float,
    cutoff_hz: float = 4.0,
    order: int = 2,
) -> np.ndarray:
    if len(y) < max(3 * order, 8):
        return y.astype(np.float64)
    nyq = 0.5 * fs_hz
    wn = min(cutoff_hz / nyq, 0.99)
    b, a = butter(order, wn, btype="low")
    y64 = np.asarray(y, dtype=np.float64)
    mask = np.isfinite(y64)
    if not mask.any():
        return y64
    out = y64.copy()
    out[mask] = filtfilt(b, a, y64[mask], method="pad")
    return out


def air_density_kg_m3(altitude_m: float = 0.0) -> float:
    """ISA-ish simple lapse; sufficient for Bernoulli correction scale."""
    rho0 = 1.225
    scale = np.exp(-altitude_m / 8500.0)
    return float(rho0 * scale)


def bernoulli_pressure_correction_pa(speed_m_s: np.ndarray, altitude_m: float | np.ndarray = 0.0) -> np.ndarray:
    """
    Dynamic pressure q = 0.5 * rho * v^2 (Pa). Static correction adds q to measured pressure in Pa.
    """
    v = np.asarray(speed_m_s, dtype=np.float64)
    v = np.nan_to_num(v, nan=0.0)
    if np.isscalar(altitude_m):
        rho = air_density_kg_m3(float(altitude_m))
    else:
        rho = np.asarray([air_density_kg_m3(float(h)) for h in np.atleast_1d(altitude_m)])
        rho = np.broadcast_to(rho, v.shape).astype(np.float64)
    return 0.5 * rho * v * v


def bernoulli_correction_mbar(speed_m_s: np.ndarray, altitude_m: float = 0.0) -> np.ndarray:
    """Same as Pa correction, expressed in millibar (1 mbar = 100 Pa)."""
    return bernoulli_pressure_correction_pa(speed_m_s, altitude_m) / 100.0


def low_frequency_drift_anchor(
    residual: np.ndarray,
    fs_hz: float,
    cutoff_hz: float | None = None,
) -> np.ndarray:
    """
    Smooth (gps - baro) residual so barometric altitude follows WGS84 at low frequency
    while keeping high-frequency baro detail.
    """
    x = np.asarray(residual, dtype=np.float64)
    if len(x) < 8 or not np.isfinite(fs_hz) or fs_hz <= 0:
        return np.nan_to_num(x, nan=0.0)
    nyq = 0.5 * fs_hz
    cut = cutoff_hz if cutoff_hz is not None else min(0.05, fs_hz / 80.0)
    cut = max(cut, fs_hz / 1000.0)
    if cut >= nyq * 0.98:
        cut = nyq * 0.1
    try:
        return butterworth_lowpass(np.nan_to_num(x, nan=0.0), fs_hz=fs_hz, cutoff_hz=cut, order=2)
    except Exception:
        win = max(int(fs_hz * 8), 5)
        return pd.Series(x).rolling(win, center=True, min_periods=1).mean().to_numpy(dtype=np.float64)


def _strictly_increasing_time_s(unix_ns: np.ndarray, min_dt_s: float = 1e-7) -> np.ndarray:
    """
    Seconds since epoch, forced strictly increasing so np.gradient never divides by ~0
    (duplicate / out-of-order timestamps → bogus 100+ m/s Vz).
    """
    t = unix_ns.astype(np.float64) * 1e-9
    if np.any(np.isfinite(t)):
        fill = float(np.nanmedian(t[np.isfinite(t)]))
    else:
        fill = 0.0
    t = np.nan_to_num(t, nan=fill)
    n = len(t)
    if n < 2:
        return t
    out = t.copy()
    for i in range(1, n):
        if out[i] <= out[i - 1]:
            out[i] = out[i - 1] + min_dt_s
    return out


def vertical_velocity_m_s(altitude_m: np.ndarray, unix_ns: np.ndarray) -> np.ndarray:
    """dh/dt in m/s: gradient w.r.t. strictly increasing time (seconds from unix_ns)."""
    h = np.asarray(altitude_m, dtype=np.float64)
    if len(h) < 2:
        return np.zeros_like(h, dtype=np.float64)
    t = _strictly_increasing_time_s(unix_ns)
    vz = np.gradient(h, t)
    vz = np.nan_to_num(vz, nan=0.0, posinf=0.0, neginf=0.0)
    # Hard cap: MTB vertical motion; kills remaining single-sample spikes
    return np.clip(vz, -50.0, 50.0)


def smooth_altitude_cubic_spline(
    unix_ns: np.ndarray,
    altitude_m: np.ndarray,
) -> np.ndarray:
    """Natural cubic spline in time; returns smoothed altitude at same points."""
    t = (unix_ns.astype(np.float64) - float(unix_ns[0])) * 1e-9
    h = np.asarray(altitude_m, dtype=np.float64)
    mask = np.isfinite(h) & np.isfinite(t)
    if mask.sum() < 4:
        return h
    cs = CubicSpline(t[mask], h[mask], extrapolate=True)
    return cs(t)


def savgol_smooth_series(
    y: np.ndarray,
    fs_hz: float,
    window_s: float = 1.0,
    polyorder: int = 3,
) -> np.ndarray:
    """Savitzky–Golay on an evenly sampled series (odd window, capped to length)."""
    y64 = np.asarray(y, dtype=np.float64)
    n = len(y64)
    if n < 7 or not np.isfinite(fs_hz) or fs_hz <= 0:
        return y64
    wl = int(round(fs_hz * window_s)) | 1
    wl = max(5, min(wl, n - (1 - (n % 2))))
    if wl % 2 == 0:
        wl -= 1
    if wl < 5 or n <= wl:
        return y64
    po = min(polyorder, wl - 1)
    if po < 1:
        return y64
    try:
        return savgol_filter(np.nan_to_num(y64, nan=np.nanmedian(y64)), wl, po)
    except Exception:
        return y64


def savgol_smooth_altitude(
    y: np.ndarray,
    fs_hz: float,
    window_s: float = 1.0,
    polyorder: int = 3,
) -> np.ndarray:
    """Strong Savitzky–Golay on altitude before Vz (trend of descent, not bike vibration)."""
    return savgol_smooth_series(y, fs_hz, window_s=window_s, polyorder=polyorder)


def estimate_sample_rate_hz(unix_ns: np.ndarray) -> float:
    d = np.diff(unix_ns.astype(np.float64) * 1e-9)
    d = d[d > 0]
    if len(d) == 0:
        return 25.0
    med = float(np.median(d))
    return 1.0 / med if med > 0 else 25.0
