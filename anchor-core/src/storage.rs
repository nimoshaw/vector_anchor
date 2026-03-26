// anchor-core/src/storage.rs
// SQLite persistence layer using rusqlite

use rusqlite::{params, Connection, Result as SqliteResult};

/// Initialize the database schema (all 6 tables + indexes)
pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS model_meta (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            model_id    TEXT NOT NULL,
            dimensions  INTEGER NOT NULL,
            fingerprint TEXT NOT NULL,
            is_active   INTEGER DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS files (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            path        TEXT UNIQUE NOT NULL,
            hash        TEXT NOT NULL,
            size        INTEGER,
            mtime       INTEGER,
            indexed_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            start_line  INTEGER,
            end_line    INTEGER,
            content     TEXT NOT NULL,
            heading     TEXT,
            vector      BLOB,
            stale       INTEGER DEFAULT 0,
            created_at  TEXT DEFAULT (datetime('now')),
            UNIQUE(file_id, chunk_index)
        );

        CREATE TABLE IF NOT EXISTS tags (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            weight      REAL DEFAULT 1.0,
            vector      BLOB,
            stale       INTEGER DEFAULT 0,
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS file_tags (
            file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (file_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS tag_cooccurrence (
            tag_a_id    INTEGER REFERENCES tags(id),
            tag_b_id    INTEGER REFERENCES tags(id),
            weight      REAL DEFAULT 0.0,
            PRIMARY KEY (tag_a_id, tag_b_id)
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_stale ON chunks(stale) WHERE stale = 1;
        CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
        ",
    )?;
    Ok(())
}

/// Insert or update a file record, returns file id
pub fn upsert_file(
    conn: &Connection,
    path: &str,
    hash: &str,
    size: i64,
    mtime: i64,
) -> SqliteResult<i64> {
    conn.execute(
        "INSERT INTO files (path, hash, size, mtime)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET
            hash = excluded.hash,
            size = excluded.size,
            mtime = excluded.mtime,
            indexed_at = datetime('now')",
        params![path, hash, size, mtime],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Insert a chunk with its vector blob
pub fn insert_chunk(
    conn: &Connection,
    file_id: i64,
    chunk_index: i32,
    start_line: Option<i32>,
    end_line: Option<i32>,
    content: &str,
    heading: Option<&str>,
    vector: &[u8],
) -> SqliteResult<i64> {
    conn.execute(
        "INSERT OR REPLACE INTO chunks (file_id, chunk_index, start_line, end_line, content, heading, vector)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![file_id, chunk_index, start_line, end_line, content, heading, vector],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Delete all chunks belonging to a file
pub fn delete_chunks_by_file(conn: &Connection, file_id: i64) -> SqliteResult<usize> {
    conn.execute("DELETE FROM chunks WHERE file_id = ?1", params![file_id])
}

/// Delete a file and its chunks (cascade)
pub fn delete_file(conn: &Connection, path: &str) -> SqliteResult<usize> {
    conn.execute("DELETE FROM files WHERE path = ?1", params![path])
}

/// Get all chunk vectors for HNSW index recovery
/// Returns Vec<(chunk_id, vector_blob)>
pub fn get_all_chunk_vectors(conn: &Connection) -> SqliteResult<Vec<(u32, Vec<u8>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, vector FROM chunks WHERE vector IS NOT NULL AND stale = 0",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, u32>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    rows.collect()
}

/// Get all tag vectors for HNSW index recovery
/// Returns Vec<(tag_id, vector_blob)>
pub fn get_all_tag_vectors(conn: &Connection) -> SqliteResult<Vec<(u32, Vec<u8>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, vector FROM tags WHERE vector IS NOT NULL AND stale = 0",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, u32>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    rows.collect()
}

/// Get total chunk count
pub fn get_chunk_count(conn: &Connection) -> SqliteResult<u32> {
    conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))
}

/// Get total file count
pub fn get_file_count(conn: &Connection) -> SqliteResult<u32> {
    conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
}

/// Mark all chunks as stale (for model migration)
pub fn mark_all_chunks_stale(conn: &Connection) -> SqliteResult<usize> {
    conn.execute("UPDATE chunks SET stale = 1", [])
}

/// Mark all tags as stale (for model migration)
pub fn mark_all_tags_stale(conn: &Connection) -> SqliteResult<usize> {
    conn.execute("UPDATE tags SET stale = 1", [])
}

/// Upsert model meta, deactivating previous active models
pub fn upsert_model_meta(
    conn: &Connection,
    model_id: &str,
    dimensions: u32,
    fingerprint: &str,
) -> SqliteResult<()> {
    conn.execute("UPDATE model_meta SET is_active = 0", [])?;
    conn.execute(
        "INSERT INTO model_meta (model_id, dimensions, fingerprint, is_active)
         VALUES (?1, ?2, ?3, 1)",
        params![model_id, dimensions, fingerprint],
    )?;
    Ok(())
}

/// Get the active model fingerprint
pub fn get_active_model(conn: &Connection) -> SqliteResult<Option<(String, u32, String)>> {
    let mut stmt = conn.prepare(
        "SELECT model_id, dimensions, fingerprint FROM model_meta WHERE is_active = 1 LIMIT 1",
    )?;
    let mut rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u32>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Get file by path, returns (id, hash)
pub fn get_file_by_path(conn: &Connection, path: &str) -> SqliteResult<Option<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, hash FROM files WHERE path = ?1")?;
    let mut rows = stmt.query_map(params![path], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}
