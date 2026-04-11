"""Load CSV frames and normalize column names to a tidy internal schema.

Assumes Sensor Logger **Standardise Units & Frames** is enabled (m s⁻² accelerometer, consistent axes).
Pressure is taken as **millibar (mbar = hPa)** unless values clearly look like pascals.
"""

from __future__ import annotations

import io
import re
from pathlib import Path

import numpy as np
import pandas as pd

from app.processing.constants import hypsometric_altitude_m

TIME_ALIASES = (
    "unix_ns",
    "time_ns",
    "timestamp_ns",
    "timestamp",
    "time",
    "epoch_ns",
    "datetime",
)
LAT_ALIASES = ("latitude", "lat", "Latitude", "LAT")
LON_ALIASES = ("longitude", "lon", "lng", "Longitude", "LON")
SPEED_ALIASES = ("speed", "Speed", "gps_speed", "velocity")
ACC_ALIASES = ("horizontal_accuracy", "accuracy", "h_acc", "gps_accuracy", "Accuracy")
ALT_GPS_ALIASES = ("altitude", "gps_altitude", "Altitude")
PRESSURE_ALIASES = ("pressure", "barometric_pressure", "Pressure", "pres")
# App "meters since start" — not WGS84 ellipsoid height
REL_ALT_APP_ALIASES = ("relativealtitude", "relative_altitude", "relativeAltitude", "barometric_altitude")

ROLL_ALIASES = ("roll", "Roll", "orientation_roll", "orientationRoll")
PITCH_ALIASES = ("pitch", "Pitch", "orientation_pitch", "orientationPitch")
YAW_ALIASES = ("yaw", "Yaw", "orientation_yaw", "orientationYaw", "heading", "Heading")


def _first_present(cols: dict[str, str], aliases: tuple[str, ...]) -> str | None:
    lower = {c.lower(): c for c in cols}
    for a in aliases:
        if a in cols:
            return a
        al = a.lower()
        if al in lower:
            return lower[al]
    return None


def _to_unix_ns(series: pd.Series) -> pd.Series:
    s = pd.to_numeric(series, errors="coerce")
    if s.max() is not pd.NA and s.max() < 1e12:  # likely seconds
        return (s * 1e9).astype("int64")
    if s.max() is not pd.NA and s.max() < 1e15:  # milliseconds
        return (s * 1e6).astype("int64")
    return s.astype("int64")


def normalize_timestamp(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    tcol = _first_present({c: c for c in out.columns}, TIME_ALIASES)
    if tcol is None:
        raise ValueError("No timestamp column found (expected unix_ns, timestamp, etc.)")
    if str(out[tcol].dtype) == "datetime64[ns]" or "datetime" in str(out[tcol].dtype):
        out["unix_ns"] = (out[tcol].astype("int64") // 10**9 * 10**9).astype("int64")
    else:
        out["unix_ns"] = _to_unix_ns(out[tcol])
    return out


def load_csv_bytes(data: bytes) -> pd.DataFrame:
    return pd.read_csv(io.BytesIO(data))


def pressure_series_to_mbar(series: pd.Series) -> pd.Series:
    """Values ~1000 → mbar; values ~1e5 → Pa → mbar."""
    p = pd.to_numeric(series, errors="coerce")
    med = float(np.nanmedian(p.to_numpy()))
    if np.isfinite(med) and med > 2_000.0:
        return p / 100.0
    return p


def _maybe_radians(series: pd.Series) -> pd.Series:
    s = pd.to_numeric(series, errors="coerce")
    m = float(np.nanmax(np.abs(s.to_numpy())))
    if np.isfinite(m) and m > 3.6:
        return np.radians(s)
    return s


def _column_lookup_lower(src: pd.DataFrame) -> dict[str, str]:
    return {str(c).lower(): c for c in src.columns}


def _has_sensor_logger_xyz(src: pd.DataFrame) -> bool:
    lower = set(_column_lookup_lower(src))
    return {"x", "y", "z"}.issubset(lower)


def _extract_sensor_logger_xyz(out: pd.DataFrame, src: pd.DataFrame, prefix: str) -> None:
    """Map Sensor Logger columns x,y,z → {prefix}_x, {prefix}_y, {prefix}_z (e.g. acc_x, gyro_x)."""
    cmap = _column_lookup_lower(src)
    for axis in "xyz":
        col = cmap.get(axis)
        if col is None:
            continue
        out[f"{prefix}_{axis}"] = pd.to_numeric(src[col], errors="coerce")


def sensor_stream_prefix_from_filename(source_name: str) -> str | None:
    """
    Distinct column prefixes so Accelerometer, TotalAcceleration, Gyroscope, etc. merge without clash.
    Returns None for streams that are not auxiliary axis CSVs.
    """
    stem = Path(source_name).stem.lower().replace(" ", "").replace("-", "_")
    stem_compact = stem.replace("_", "")
    if stem == "metadata" or stem_compact == "metadata":
        return None
    if stem == "location" or stem.startswith("location"):
        return None
    if "barometer" in stem_compact:
        return None
    if "gyroscopeuncalibrated" in stem_compact or "gyroscope_uncalibrated" in stem:
        return "gyro_uncal"
    if stem_compact.startswith("gyroscope") or stem == "gyroscope":
        return "gyro"
    if "accelerometeruncalibrated" in stem_compact or "accelerometer_uncalibrated" in stem:
        return "acc_uncal"
    if "totalacceleration" in stem_compact or stem.startswith("total_acceleration"):
        return "total_acc"
    # Multi-ZIP prefixes produce stems like z0_gravity → stem_compact z0gravity (not startswith "gravity").
    if "gravity" in stem_compact:
        return "gravity"
    if "accelerometer" in stem_compact:
        return "acc"
    return "acc"


def _extract_acc_columns(out: pd.DataFrame, src: pd.DataFrame) -> None:
    colmap = set(src.columns)
    for axis, name in zip("xyz", ("acc_x", "acc_y", "acc_z")):
        for cand in (
            f"acceleration_{axis}",
            f"accel_{axis}",
            f"a{axis}",
            f"Acceleration {axis.upper()}",
            f"acceleration {axis}",
            f"linear_acceleration_{axis}",
            f"linearAcceleration{axis.upper()}",
            f"Acc{axis.upper()}",
        ):
            if cand in colmap:
                out[name] = pd.to_numeric(src[cand], errors="coerce")
                break
        else:
            for c in src.columns:
                m = re.match(rf"acceleration\s*{axis}\b", str(c), re.IGNORECASE)
                if m:
                    out[name] = pd.to_numeric(src[c], errors="coerce")
                    break


def _extract_orientation_columns(out: pd.DataFrame, src: pd.DataFrame) -> None:
    rc = _first_present({c: c for c in src.columns}, ROLL_ALIASES)
    pc = _first_present({c: c for c in src.columns}, PITCH_ALIASES)
    yc = _first_present({c: c for c in src.columns}, YAW_ALIASES)
    if rc:
        out["roll_rad"] = _maybe_radians(src[rc])
    if pc:
        out["pitch_rad"] = _maybe_radians(src[pc])
    if yc:
        out["yaw_rad"] = _maybe_radians(src[yc])


def tidy_gps(df: pd.DataFrame) -> pd.DataFrame:
    out = normalize_timestamp(df)
    lat_c = _first_present({c: c for c in out.columns}, LAT_ALIASES)
    lon_c = _first_present({c: c for c in out.columns}, LON_ALIASES)
    if lat_c is None or lon_c is None:
        raise ValueError("GPS CSV missing latitude/longitude")
    tidy = pd.DataFrame(
        {
            "unix_ns": out["unix_ns"],
            "latitude": pd.to_numeric(out[lat_c], errors="coerce"),
            "longitude": pd.to_numeric(out[lon_c], errors="coerce"),
        }
    )
    sp = _first_present({c: c for c in out.columns}, SPEED_ALIASES)
    if sp:
        tidy["speed_m_s"] = pd.to_numeric(out[sp], errors="coerce")
    ac = _first_present({c: c for c in out.columns}, ACC_ALIASES)
    if ac:
        tidy["horizontal_accuracy_m"] = pd.to_numeric(out[ac], errors="coerce")
    ag = _first_present({c: c for c in out.columns}, ALT_GPS_ALIASES)
    if ag:
        tidy["gps_altitude_m"] = pd.to_numeric(out[ag], errors="coerce")
    tidy = tidy.dropna(subset=["latitude", "longitude"]).sort_values("unix_ns").reset_index(drop=True)
    return tidy


def tidy_highfreq(df: pd.DataFrame) -> pd.DataFrame:
    """Barometer / primary high-rate row: pressure (mbar), app relative altitude, optional IMU."""
    out = normalize_timestamp(df)
    tidy = pd.DataFrame({"unix_ns": out["unix_ns"]})
    pr = _first_present({c: c for c in out.columns}, PRESSURE_ALIASES)
    ra = _first_present({c: c for c in out.columns}, REL_ALT_APP_ALIASES)

    if pr:
        tidy["pressure_mbar"] = pressure_series_to_mbar(out[pr])
    if ra:
        tidy["relative_altitude_app_m"] = pd.to_numeric(out[ra], errors="coerce")

    if pr:
        tidy["altitude_from_pressure_m"] = hypsometric_altitude_m(tidy["pressure_mbar"].to_numpy())
        tidy["altitude_m"] = tidy["altitude_from_pressure_m"]
    elif ra:
        tidy["altitude_m"] = tidy["relative_altitude_app_m"]
    else:
        ag = _first_present({c: c for c in out.columns}, ALT_GPS_ALIASES)
        if ag:
            tidy["altitude_m"] = pd.to_numeric(out[ag], errors="coerce")
        else:
            raise ValueError("High-frequency baro CSV needs pressure, relativeAltitude, or altitude")

    _extract_acc_columns(tidy, out)
    if _has_sensor_logger_xyz(out) and not any(c in tidy.columns for c in ("acc_x", "acc_y", "acc_z")):
        _extract_sensor_logger_xyz(tidy, out, "acc")
    _extract_orientation_columns(tidy, out)

    tidy = tidy.dropna(subset=["unix_ns"]).sort_values("unix_ns").reset_index(drop=True)
    return tidy


def tidy_hf_aux(df: pd.DataFrame, source_name: str = "") -> pd.DataFrame:
    """Accelerometer / gyro / total-acceleration / orientation Sensor Logger exports."""
    out = normalize_timestamp(df)
    tidy = pd.DataFrame({"unix_ns": out["unix_ns"]})
    pfx = sensor_stream_prefix_from_filename(source_name) if source_name else "acc"
    if pfx and _has_sensor_logger_xyz(out):
        _extract_sensor_logger_xyz(tidy, out, pfx)
    _extract_acc_columns(tidy, out)
    _extract_orientation_columns(tidy, out)
    if len(tidy.columns) <= 1:
        raise ValueError("Auxiliary IMU CSV has no accelerometer, gyro, or orientation columns")
    tidy = tidy.dropna(subset=["unix_ns"]).sort_values("unix_ns").reset_index(drop=True)
    return tidy


def median_dt_seconds(unix_ns: pd.Series) -> float:
    d = unix_ns.diff().dropna().astype("float64") / 1e9
    return float(d.median()) if len(d) else 1.0


def classify_csv(df: pd.DataFrame, source_name: str = "") -> str:
    """
    metadata — skip (Sensor Logger Metadata.csv)
    gps — Location / GPS with lat/lon
    hf_baro — Barometer.csv (pressure / relativeAltitude)
    hf_aux — Accelerometer, Gyroscope, TotalAcceleration, *Uncalibrated*, etc.
    """
    fn = Path(source_name).name.lower() if source_name else ""
    if fn == "metadata.csv" or (fn.endswith(".csv") and fn.replace(".csv", "") == "metadata"):
        return "metadata"

    has_ll = _first_present({c: c for c in df.columns}, LAT_ALIASES) and _first_present(
        {c: c for c in df.columns}, LON_ALIASES
    )
    stem = Path(source_name).stem.lower() if source_name else ""
    if stem == "location" or stem.startswith("location"):
        if has_ll:
            return "gps"
    if "barometer" in stem.replace("-", "").replace(" ", ""):
        pr = _first_present({c: c for c in df.columns}, PRESSURE_ALIASES)
        ra = _first_present({c: c for c in df.columns}, REL_ALT_APP_ALIASES)
        if pr is not None or ra is not None:
            return "hf_baro"

    try:
        t = normalize_timestamp(df)["unix_ns"]
    except ValueError:
        return "unknown"
    dt = median_dt_seconds(t)
    pr = _first_present({c: c for c in df.columns}, PRESSURE_ALIASES)
    ra = _first_present({c: c for c in df.columns}, REL_ALT_APP_ALIASES)
    has_baro = pr is not None or ra is not None
    has_xyz = _has_sensor_logger_xyz(df)
    has_acc = (
        any(
            c in df.columns
            for c in ("acceleration_x", "acceleration_y", "acceleration_z", "accel_x", "linear_acceleration_x")
        )
        or any(f"Acceleration {x}" in df.columns for x in ("X", "Y", "Z"))
        or has_xyz
    )
    has_ori = any(
        _first_present({c: c for c in df.columns}, aliases) is not None
        for aliases in (ROLL_ALIASES, PITCH_ALIASES, YAW_ALIASES)
    )

    def _named_motion_sensor(name: str) -> bool:
        if not name:
            return False
        sc = Path(name).stem.lower().replace(" ", "").replace("-", "").replace("_", "")
        # Substrings so z0gravity / z1accelerometer (multi-ZIP name prefixes) still match.
        return (
            "accelerometer" in sc
            or "gyroscope" in sc
            or "totalacceleration" in sc
            or "gravity" in sc
        )

    if source_name and _named_motion_sensor(source_name) and not has_baro and not has_ll:
        if has_xyz or has_acc or has_ori:
            return "hf_aux"

    if has_ll and dt > 0.35:
        return "gps"
    if has_baro:
        return "hf_baro"
    if has_acc or has_ori:
        return "hf_aux"
    if has_ll:
        return "gps"
    if dt < 0.2 and has_xyz:
        return "hf_aux"
    return "unknown"
