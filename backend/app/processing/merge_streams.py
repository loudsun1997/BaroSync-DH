"""Merge Barometer, Accelerometer, and Orientation CSVs on a common high-rate timeline."""

from __future__ import annotations

import pandas as pd

# Match samples within 50 ms (Sensor Logger ~25–100 Hz)
DEFAULT_TOLERANCE_NS = 50_000_000


def merge_asof_on_unix_ns(
    left: pd.DataFrame,
    right: pd.DataFrame,
    tolerance_ns: int = DEFAULT_TOLERANCE_NS,
) -> pd.DataFrame:
    """Nearest-neighbour merge on monotonic unix_ns (integer nanoseconds)."""
    if right.empty:
        return left
    l = left.sort_values("unix_ns").reset_index(drop=True)
    r = right.sort_values("unix_ns").reset_index(drop=True)
    rcols = [c for c in r.columns if c != "unix_ns"]
    if not rcols:
        return l
    overlap = [c for c in rcols if c in l.columns]
    rename = {c: f"{c}__aux" for c in overlap}
    r = r[["unix_ns", *rcols]].rename(columns=rename)
    merged = pd.merge_asof(l, r, on="unix_ns", direction="nearest", tolerance=tolerance_ns)
    for c in overlap:
        aux_c = f"{c}__aux"
        if aux_c in merged.columns:
            # Dedicated Sensor Logger exports (e.g. Orientation.csv) override baro-row values when present
            merged[c] = merged[aux_c].combine_first(merged[c])
            merged.drop(columns=[aux_c], inplace=True)
    return merged


def merge_baro_frames(baro_dfs: list[pd.DataFrame]) -> pd.DataFrame:
    """Outer-join multiple baro exports on unix_ns; coalesce duplicate column names."""
    if not baro_dfs:
        raise ValueError("No barometer/highfreq base frames")
    base = baro_dfs[0].sort_values("unix_ns").reset_index(drop=True)
    for other in baro_dfs[1:]:
        o = other.sort_values("unix_ns").reset_index(drop=True)
        merged = pd.merge(base, o, on="unix_ns", how="outer", suffixes=("", "_r"))
        for c in list(merged.columns):
            if not c.endswith("_r"):
                continue
            orig = c[:-2]
            if orig in merged.columns:
                merged[orig] = merged[orig].combine_first(merged[c])
            else:
                merged.rename(columns={c: orig}, inplace=True)
            merged.drop(columns=[c], inplace=True, errors="ignore")
        base = merged.sort_values("unix_ns").reset_index(drop=True)
    return base


def attach_auxiliary_streams(base: pd.DataFrame, aux_dfs: list[pd.DataFrame]) -> pd.DataFrame:
    out = base
    for aux in aux_dfs:
        out = merge_asof_on_unix_ns(out, aux)
    return out
