"""Sensor Logger / barometric constants (standardized units & frames assumed)."""

import numpy as np

# Sea-level reference; 1013.25 mbar = 1013.25 hPa = 101325 Pa
P0_MBAR = 1013.25

STANDARD_GRAVITY_MS2 = 9.80665


def hypsometric_altitude_m(P_mbar: np.ndarray | float, P0_mbar: float = P0_MBAR) -> np.ndarray:
    """Altitude (m) from static pressure; P and P0 in millibar (mbar = hPa)."""
    p = np.asarray(P_mbar, dtype=np.float64)
    return 44330.0 * (1.0 - (p / P0_mbar) ** 0.1903)
