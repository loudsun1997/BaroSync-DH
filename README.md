# BaroSync DH

Telemetry lab: FastAPI backend processes Sensor Logger CSVs (GPS ~1 Hz + baro/IMU ~25 Hz); React frontend shows GPS trail + Plotly charts (no map API keys).

## Sensor Logger settings (important)

Turn **Standardise Units & Frames** **ON** before recording. That keeps accelerometer data in **m s⁻²**, orientation in a consistent frame, and avoids platform-specific axis flips when you change devices (e.g. Android ↔ iPhone).

## Data assumptions (what the pipeline implements)

| Topic | Spec |
| --- | --- |
| Time | Nanoseconds since Unix epoch internally; exported as **`time_s`** (seconds elapsed from first sample). |
| Pressure | Treated as **millibar (mbar)**; **1 mbar = 1 hPa**. Values that look like **pascals** (~1e5) are divided by 100. Sea-level reference **P₀ = 1013.25 mbar** for hypsometric altitude. |
| Hypsometric altitude | **h = 44330 × (1 − (P/P₀)^0.1903)** with **P** and **P₀** in mbar. |
| `relativeAltitude` | App “meters since start”; stored as **`relative_altitude_app_m`** and compared to pressure altitude in **`sanity_pressure_minus_app_m`**. |
| GPS altitude | **WGS84 ellipsoid** `altitude` interpolated to the baro time grid; a **low-pass (gps − baro)** offset anchors long-wavelength baro drift (**`gps_wgs84_anchor_offset_m`**). |
| Speed | **m s⁻¹** for **Bernoulli** dynamic-pressure correction on barometer readings. |
| IMU | **Linear acceleration** (e.g. `Accelerometer.csv`) for impacts / lateral load; **orientation** (pitch, roll, yaw in radians, or degrees auto-detected) for **lean** and berm heuristics. |

You can ZIP **separate** Sensor Logger exports (**GPS**, **Barometer**, **Accelerometer**, **Orientation**); they are merged on timestamp (barometer stream is the master clock). For multiple laps, use **matching counts** of GPS and barometer CSVs (sorted by file path), or **one** GPS file for the whole session.

## Prerequisites

- Python 3.11+ (3.13 works)
- Node.js 20+ (for the frontend)

## One command (API + UI)

From the repository root (after venv + `npm install` once):

```bash
./start.sh
```

Press Ctrl+C to stop both servers.

## Backend

From the repository root:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- API: `http://127.0.0.1:8000`
- Health: `GET http://127.0.0.1:8000/health`
- Upload: `POST http://127.0.0.1:8000/upload` (multipart form field **`zip_file`**, ZIP of CSVs)
- Local folder under `data/`: `POST http://127.0.0.1:8000/process-data-folder?subpath=YourFolderName` (path must stay inside the repo’s `data/` directory)

Process a Sensor Logger export directory from the shell (same logic as the API):

```bash
PYTHONPATH=backend backend/.venv/bin/python scripts/process_folder.py data/Tenaka_Place-2026-04-10_17-12-46
```

## Frontend

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

The dev server proxies `/upload` and `/health` to the backend on port 8000 (see `frontend/vite.config.ts`).

Production build:

```bash
cd frontend
npm run build
npm run preview
```

## Sanity check (matplotlib)

Uses the same processing pipeline as the API and writes `sanity_altitude_vs_speed.png` in the repo root.

```bash
cd backend
.venv/bin/pip install -r ../scripts/requirements-sanity.txt
cd ..
PYTHONPATH=backend backend/.venv/bin/python scripts/sanity_check.py path/to/session.zip
# Or two CSVs:
PYTHONPATH=backend backend/.venv/bin/python scripts/sanity_check.py path/to/highfreq.csv path/to/gps.csv
# Or a Sensor Logger folder (all CSVs merged on time):
PYTHONPATH=backend backend/.venv/bin/python scripts/sanity_check.py data/Tenaka_Place-2026-04-10_17-12-46
```

## Project layout

- `backend/app/` — FastAPI app and `processing/` pipeline
- `frontend/src/` — React UI (Plotly GPS trail + charts)
- `scripts/sanity_check.py` — quick altitude vs speed plot
