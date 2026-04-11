#!/usr/bin/env python3
"""
Sanity check: load Sensor Logger CSVs, ZIP, or a folder, run the same pipeline as the API,
and plot altitude vs GPS speed using matplotlib.
Usage:
  PYTHONPATH=backend python scripts/sanity_check.py path/to/session_folder
  PYTHONPATH=backend python scripts/sanity_check.py path/to/session.zip
  PYTHONPATH=backend python scripts/sanity_check.py path/to/baro.csv path/to/gps.csv
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.processing.ingest import (  # noqa: E402
    classify_csv,
    load_csv_bytes,
    tidy_gps,
    tidy_hf_aux,
    tidy_highfreq,
)
from app.processing.merge_streams import attach_auxiliary_streams, merge_baro_frames  # noqa: E402
from app.processing.pipeline import (  # noqa: E402
    process_directory,
    process_highfreq_frame,
)


def _fuse_from_lists(baro_list: list, aux_list: list) -> pd.DataFrame:
    if not baro_list:
        raise ValueError("Need at least one barometer / relative-altitude CSV")
    base = merge_baro_frames(baro_list)
    return attach_auxiliary_streams(base, aux_list) if aux_list else base


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    first = Path(args[0])
    if first.is_dir():
        result = process_directory(first)
        if not result.get("runs"):
            print("No runs produced.")
            sys.exit(1)
        tel = result["runs"][0]["telemetry"]
        df = pd.DataFrame(tel)
        alt = df["altitude_smooth_m"].to_numpy()
        spd = df["speed_m_s"].to_numpy()
        mask = pd.notna(alt) & pd.notna(spd)
        time_c = df["time_s"].to_numpy()[mask] if "time_s" in df.columns else None
    else:
        gps_df: pd.DataFrame | None = None
        baro_list: list[pd.DataFrame] = []
        aux_list: list[pd.DataFrame] = []

        for p in args:
            path = Path(p)
            if path.suffix.lower() == ".zip":
                with zipfile.ZipFile(path, "r") as zf:
                    for name in sorted(zf.namelist()):
                        if not name.lower().endswith(".csv"):
                            continue
                        base = Path(name).name
                        df = load_csv_bytes(zf.read(name))
                        kind = classify_csv(df, base)
                        if kind == "metadata":
                            continue
                        if kind == "gps" and gps_df is None:
                            gps_df = tidy_gps(df)
                        elif kind == "hf_baro":
                            baro_list.append(tidy_highfreq(df))
                        elif kind == "hf_aux":
                            aux_list.append(tidy_hf_aux(df, base))
            else:
                raw = path.read_bytes()
                df = load_csv_bytes(raw)
                kind = classify_csv(df, path.name)
                if kind == "metadata":
                    continue
                if kind == "gps":
                    gps_df = tidy_gps(df)
                elif kind == "hf_baro":
                    baro_list.append(tidy_highfreq(df))
                elif kind == "hf_aux":
                    aux_list.append(tidy_hf_aux(df, path.name))
                else:
                    print(f"Unrecognized CSV type for {path}: {kind!r}")
                    sys.exit(1)

        if gps_df is None:
            print("Need a GPS CSV.")
            sys.exit(1)
        try:
            hf_df = _fuse_from_lists(baro_list, aux_list)
        except ValueError as e:
            print(e)
            sys.exit(1)

        proc = process_highfreq_frame(hf_df, gps_df)
        alt = proc["altitude_smooth_m"].to_numpy()
        spd = proc["speed_m_s"].to_numpy()
        mask = pd.notna(alt) & pd.notna(spd)
        time_c = proc["time_s"].to_numpy()[mask]

    fig, ax = plt.subplots(figsize=(9, 5))
    sc = ax.scatter(
        spd[mask],
        alt[mask],
        s=2,
        alpha=0.35,
        c=time_c if time_c is not None else range(int(mask.sum())),
        cmap="viridis",
    )
    ax.set_xlabel("GPS speed (m/s)")
    ax.set_ylabel("Smoothed altitude (m)")
    ax.set_title("Sanity: altitude vs speed (color = time)")
    plt.colorbar(sc, ax=ax).set_label("Time (s)")
    plt.tight_layout()
    out = ROOT / "sanity_altitude_vs_speed.png"
    fig.savefig(out, dpi=150)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
