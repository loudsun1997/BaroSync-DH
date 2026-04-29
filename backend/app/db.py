from __future__ import annotations

import json
import hashlib
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DATA_ROOT = _REPO_ROOT / "data"
_DB_PATH = _DATA_ROOT / "barosync.db"
_RESULT_ROOT = _DATA_ROOT / "upload_results"
_BLOB_ROOT = _DATA_ROOT / "blobs"


def _connect() -> sqlite3.Connection:
    _DATA_ROOT.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(_DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db() -> None:
    _RESULT_ROOT.mkdir(parents=True, exist_ok=True)
    _BLOB_ROOT.mkdir(parents=True, exist_ok=True)
    with _connect() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS trails (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                location TEXT,
                description TEXT,
                run_count INTEGER NOT NULL DEFAULT 0,
                session_count INTEGER NOT NULL DEFAULT 0,
                total_distance_m REAL,
                elevation_min_m REAL,
                elevation_max_m REAL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS upload_sessions (
                id TEXT PRIMARY KEY,
                trail_id TEXT REFERENCES trails(id) ON DELETE SET NULL,
                status TEXT NOT NULL,
                source_names_json TEXT NOT NULL DEFAULT '[]',
                run_count INTEGER NOT NULL DEFAULT 0,
                comparison_ready INTEGER NOT NULL DEFAULT 0,
                alignment_method TEXT,
                shared_distance_m REAL,
                result_json_path TEXT,
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
                trail_id TEXT REFERENCES trails(id) ON DELETE SET NULL,
                label TEXT,
                source_name TEXT,
                color TEXT,
                duration_s REAL,
                distance_m REAL,
                sample_count INTEGER,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS upload_files (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
                trail_id TEXT REFERENCES trails(id) ON DELETE SET NULL,
                original_filename TEXT NOT NULL,
                stem TEXT,
                content_type TEXT,
                size_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                blob_path TEXT NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_upload_files_session
                ON upload_files(session_id);
            CREATE INDEX IF NOT EXISTS idx_upload_files_sha256
                ON upload_files(sha256);

            CREATE TABLE IF NOT EXISTS file_blobs (
                sha256 TEXT PRIMARY KEY,
                blob_path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                content_type TEXT,
                first_original_filename TEXT,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_files (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
                blob_sha256 TEXT NOT NULL REFERENCES file_blobs(sha256) ON DELETE RESTRICT,
                original_filename TEXT NOT NULL,
                stem TEXT,
                created_at REAL NOT NULL,
                UNIQUE(session_id, blob_sha256)
            );

            CREATE INDEX IF NOT EXISTS idx_session_files_session
                ON session_files(session_id);
            CREATE INDEX IF NOT EXISTS idx_session_files_blob
                ON session_files(blob_sha256);
            """
        )
        con.executescript(
            """
            INSERT OR IGNORE INTO file_blobs
                (sha256, blob_path, size_bytes, content_type, first_original_filename, created_at)
            SELECT sha256, blob_path, size_bytes, content_type, original_filename, created_at
            FROM upload_files
            ORDER BY created_at ASC;

            INSERT OR IGNORE INTO session_files
                (id, session_id, blob_sha256, original_filename, stem, created_at)
            SELECT id, session_id, sha256, original_filename, stem, created_at
            FROM upload_files
            ORDER BY created_at ASC;
            """
        )


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def list_trails() -> list[dict[str, Any]]:
    init_db()
    with _connect() as con:
        rows = con.execute(
            """
            SELECT *
            FROM trails
            ORDER BY updated_at DESC, name COLLATE NOCASE ASC
            """
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def create_trail(name: str, location: str | None = None, description: str | None = None) -> dict[str, Any]:
    init_db()
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Trail name is required")
    now = time.time()
    trail_id = uuid.uuid4().hex
    try:
        with _connect() as con:
            con.execute(
                """
                INSERT INTO trails
                    (id, name, location, description, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (trail_id, clean_name, (location or "").strip(), (description or "").strip(), now, now),
            )
    except sqlite3.IntegrityError as e:
        raise ValueError(f"Trail already exists: {clean_name}") from e
    trail = get_trail(trail_id)
    if trail is None:
        raise ValueError("Trail was not created")
    return trail


def get_trail(trail_id: str) -> dict[str, Any] | None:
    init_db()
    with _connect() as con:
        row = con.execute("SELECT * FROM trails WHERE id = ?", (trail_id,)).fetchone()
    return _row_to_dict(row) if row else None


def get_or_create_trail(name: str) -> dict[str, Any]:
    init_db()
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Trail name is required")
    with _connect() as con:
        row = con.execute(
            "SELECT * FROM trails WHERE lower(name) = lower(?)",
            (clean_name,),
        ).fetchone()
    if row:
        return _row_to_dict(row)
    return create_trail(clean_name)


def _run_duration_s(run: dict[str, Any]) -> float | None:
    tel = run.get("telemetry")
    if not isinstance(tel, dict):
        return None
    time_s = tel.get("time_s")
    if isinstance(time_s, list) and len(time_s) >= 2:
        first, last = time_s[0], time_s[-1]
        if isinstance(first, (int, float)) and isinstance(last, (int, float)):
            return float(last) - float(first)
    unix_ns = tel.get("unix_ns")
    if isinstance(unix_ns, list) and len(unix_ns) >= 2:
        first, last = unix_ns[0], unix_ns[-1]
        if isinstance(first, (int, float)) and isinstance(last, (int, float)):
            return (float(last) - float(first)) / 1e9
    return None


def _last_number(values: Any) -> float | None:
    if isinstance(values, list) and values:
        v = values[-1]
        if isinstance(v, (int, float)):
            return float(v)
    return None


def _finite_min_max(values: Any) -> tuple[float | None, float | None]:
    if not isinstance(values, list):
        return None, None
    nums = [float(v) for v in values if isinstance(v, (int, float))]
    if not nums:
        return None, None
    return min(nums), max(nums)


def _blob_path_for_hash(sha256: str, original_filename: str) -> Path:
    suffix = Path(original_filename).suffix.lower() or ".blob"
    return _BLOB_ROOT / sha256[:2] / f"{sha256}{suffix}"


def _store_blob_bytes(data: bytes, original_filename: str) -> tuple[str, Path]:
    sha = hashlib.sha256(data).hexdigest()
    path = _blob_path_for_hash(sha, original_filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(data)
    return sha, path


def upload_file_hashes(uploaded_files: list[dict[str, Any]] | None) -> list[str]:
    hashes: list[str] = []
    for upload in uploaded_files or []:
        data = upload.get("bytes")
        if isinstance(data, bytes):
            hashes.append(hashlib.sha256(data).hexdigest())
    return hashes


def find_existing_session_for_hashes(
    hashes: list[str],
    *,
    trail_id: str | None,
) -> str | None:
    init_db()
    unique_hashes = sorted(set(hashes))
    if not unique_hashes:
        return None
    placeholders = ",".join("?" for _ in unique_hashes)
    trail_clause = ""
    params: list[Any] = [len(unique_hashes), *unique_hashes, len(unique_hashes)]
    if trail_id is not None:
        trail_clause = "AND upload_sessions.trail_id = ?"
        params.append(trail_id)
    with _connect() as con:
        row = con.execute(
            f"""
            SELECT upload_sessions.id
            FROM upload_sessions
            WHERE
                (SELECT COUNT(DISTINCT blob_sha256)
                 FROM session_files
                 WHERE session_files.session_id = upload_sessions.id) = ?
                AND
                (SELECT COUNT(DISTINCT blob_sha256)
                 FROM session_files
                 WHERE session_files.session_id = upload_sessions.id
                   AND blob_sha256 IN ({placeholders})) = ?
                {trail_clause}
            ORDER BY upload_sessions.created_at DESC
            LIMIT 1
            """,
            params,
        ).fetchone()
    return str(row["id"]) if row else None


def persist_upload_result(
    result: dict[str, Any],
    *,
    trail_id: str | None,
    source_names: list[str],
    uploaded_files: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    init_db()
    now = time.time()
    session_id = uuid.uuid4().hex

    runs = result.get("runs") if isinstance(result.get("runs"), list) else []
    stored_run_count = len(source_names) or len(uploaded_files or []) or len(runs)

    with _connect() as con:
        con.execute(
            """
            INSERT INTO upload_sessions
                (id, trail_id, status, source_names_json, run_count, comparison_ready,
                 alignment_method, shared_distance_m, result_json_path, created_at, updated_at)
            VALUES (?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                trail_id,
                json.dumps(source_names),
                stored_run_count,
                0,
                None,
                None,
                None,
                now,
                now,
            ),
        )

        for upload in uploaded_files or []:
            data = upload.get("bytes")
            original_filename = str(upload.get("filename") or upload.get("stem") or "upload.zip")
            if not isinstance(data, bytes):
                continue
            sha, blob_path = _store_blob_bytes(data, original_filename)
            con.execute(
                """
                INSERT OR IGNORE INTO file_blobs
                    (sha256, blob_path, size_bytes, content_type, first_original_filename, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    sha,
                    str(blob_path),
                    len(data),
                    upload.get("content_type") or "application/zip",
                    original_filename,
                    now,
                ),
            )
            con.execute(
                """
                INSERT OR IGNORE INTO session_files
                    (id, session_id, blob_sha256, original_filename, stem, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    session_id,
                    sha,
                    original_filename,
                    upload.get("stem"),
                    now,
                ),
            )

        if trail_id:
            con.execute(
                """
                UPDATE trails
                SET
                    run_count = run_count + ?,
                    session_count = session_count + 1,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    stored_run_count,
                    now,
                    trail_id,
                ),
            )
    return {"session_id": session_id, "result_json_path": None}


def list_sessions(trail_id: str | None = None, limit: int = 25) -> list[dict[str, Any]]:
    init_db()
    limit = max(1, min(int(limit), 200))
    with _connect() as con:
        if trail_id:
            rows = con.execute(
                """
            SELECT upload_sessions.*,
                   COUNT(session_files.id) AS file_count,
                   COALESCE(SUM(file_blobs.size_bytes), 0) AS file_bytes
            FROM upload_sessions
            LEFT JOIN session_files ON session_files.session_id = upload_sessions.id
            LEFT JOIN file_blobs ON file_blobs.sha256 = session_files.blob_sha256
            WHERE upload_sessions.trail_id = ?
            GROUP BY upload_sessions.id
            ORDER BY upload_sessions.created_at DESC
            LIMIT ?
                """,
                (trail_id, limit),
            ).fetchall()
        else:
            rows = con.execute(
                """
            SELECT upload_sessions.*,
                   COUNT(session_files.id) AS file_count,
                   COALESCE(SUM(file_blobs.size_bytes), 0) AS file_bytes
            FROM upload_sessions
            LEFT JOIN session_files ON session_files.session_id = upload_sessions.id
            LEFT JOIN file_blobs ON file_blobs.sha256 = session_files.blob_sha256
            GROUP BY upload_sessions.id
            ORDER BY upload_sessions.created_at DESC
            LIMIT ?
                """,
                (limit,),
            ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        d = _row_to_dict(row)
        try:
            d["source_names"] = json.loads(d.pop("source_names_json") or "[]")
        except json.JSONDecodeError:
            d["source_names"] = []
        out.append(d)
    return out


def list_session_files(session_id: str) -> list[dict[str, Any]]:
    init_db()
    with _connect() as con:
        rows = con.execute(
            """
            SELECT session_files.id,
                   session_files.session_id,
                   upload_sessions.trail_id,
                   session_files.original_filename,
                   session_files.stem,
                   file_blobs.content_type,
                   file_blobs.size_bytes,
                   file_blobs.sha256,
                   file_blobs.blob_path,
                   file_blobs.created_at AS blob_created_at,
                   session_files.created_at
            FROM session_files
            JOIN file_blobs ON file_blobs.sha256 = session_files.blob_sha256
            JOIN upload_sessions ON upload_sessions.id = session_files.session_id
            WHERE session_files.session_id = ?
            ORDER BY session_files.created_at ASC, session_files.original_filename COLLATE NOCASE ASC
            """,
            (session_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_session_result(session_id: str) -> dict[str, Any] | None:
    init_db()
    with _connect() as con:
        row = con.execute(
            "SELECT result_json_path FROM upload_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    if not row:
        return None
    files = list_session_files(session_id)
    if files:
        raw_list: list[tuple[bytes, str]] = []
        for file_row in files:
            blob_path = Path(str(file_row["blob_path"]))
            if not blob_path.exists():
                return None
            stem = str(file_row.get("stem") or Path(str(file_row.get("original_filename") or "upload.zip")).stem)
            raw_list.append((blob_path.read_bytes(), stem))

        from app.processing.pipeline import process_multi_zip_bytes, process_zip_bytes

        if len(raw_list) == 1:
            result = process_zip_bytes(raw_list[0][0], source_stem=raw_list[0][1])
        else:
            result = process_multi_zip_bytes(raw_list)
        if isinstance(result, dict):
            result["database"] = {
                "session_id": session_id,
                "reprocessed_from_raw": True,
            }
        return result

    if row["result_json_path"]:
        path = Path(str(row["result_json_path"]))
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return None


init_db()
