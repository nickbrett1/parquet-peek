// parquet-store.js — read-only access to the parquet directory (server-only).
//
// Two-tier access model (see memos/parquet-peek-implementation):
//   - Manifest (metadata fast path): parquet_metadata + parquet_schema footers,
//     no data scan — instant even for multi-GB files.
//   - Profile (on-demand, cached): footer stats for null/min/max plus
//     approx_count_distinct() over a fixed-size reservoir sample.
//   - Preview: SELECT * ... LIMIT n (row-group pushdown, sub-second).
//
// All reads are metadata/limited-scan only; the data mount is read-only.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const duckdb = require("duckdb");

export const PARQUET_DIR = process.env.PARQUET_DIR || "/data";

/** Cap the sampled distinct scan to roughly this many rows (memo: ~0.28% of the 361M file ≈ 1M rows). */
export const DEFAULT_SAMPLE_TARGET_ROWS = 1_000_000;

/** Error carrying an HTTP status for the API routes. */
export class ParquetPeekError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/** Single-quote a SQL string literal, escaping embedded quotes. */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Double-quote a SQL identifier (column name), escaping embedded quotes. */
function sqlIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Reject anything that is not a bare parquet filename. Guards the API against
 * path traversal (`../`, absolute paths) while staying permissive for names
 * containing dots (e.g. `xnas-itch-20230914.mbo.parquet`).
 */
export function assertSafeFileName(name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ParquetPeekError(400, 'missing or empty "file" parameter');
  }
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new ParquetPeekError(400, "invalid file name");
  }
  if (!name.toLowerCase().endsWith(".parquet")) {
    throw new ParquetPeekError(400, "file must be a .parquet file");
  }
  return name;
}

/**
 * Normalize a value returned by the duckdb node binding for JSON transport:
 * BigInt → number when safe, else string; Date → ISO; binary → base64.
 */
export function normalizeValue(value) {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString("base64");
  }
  return value;
}

/**
 * Create a store bound to a directory. `db` is injectable for tests; the
 * default is a fresh in-memory DuckDB (the native binding is process-local).
 */
export function createParquetStore(
  dir = PARQUET_DIR,
  db = new duckdb.Database(":memory:"),
  options = {},
) {
  const sampleTargetRows =
    options.sampleTargetRows ?? DEFAULT_SAMPLE_TARGET_ROWS;

  // DuckDB cannot see the container cgroup (defaults to 80% of host RAM and
  // never spills), so a runaway query OOM-kills the container instead. Cap
  // DuckDB's own memory and give it a spill directory — it degrades to disk
  // instead of dying. This is cheap insurance on top of the bounded queries.
  const pragmaReady = (async () => {
    await run(db, "PRAGMA memory_limit='1GB'");
    await run(db, "PRAGMA temp_directory='/tmp'");
  })();

  let listingCache = { signature: null, data: null };
  const profileCache = new Map();
  const previewCache = new Map();

  function parquetFileNames() {
    let names;
    try {
      names = fs
        .readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith(".parquet"));
    } catch (err) {
      throw new ParquetPeekError(
        500,
        `cannot read parquet directory ${dir}: ${err.message}`,
      );
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  function statOf(abs, name) {
    try {
      return fs.statSync(abs);
    } catch {
      throw new ParquetPeekError(404, `file not found: ${name}`);
    }
  }

  function aggregateMetadata(metadata) {
    const rowGroups = new Map();
    const colStats = new Map();
    for (const row of metadata) {
      const rgRows = Number(row.row_group_num_rows) || 0;
      if (!rowGroups.has(row.row_group_id)) {
        rowGroups.set(row.row_group_id, rgRows);
      }
      const cur = colStats.get(row.path_in_schema) || {
        nullCount: 0,
        min: null,
        max: null,
      };
      if (row.stats_null_count !== null && row.stats_null_count !== undefined) {
        cur.nullCount += Number(row.stats_null_count) || 0;
      }
      if (row.stats_min !== null && row.stats_min !== undefined) {
        if (cur.min === null || String(row.stats_min) < String(cur.min))
          cur.min = row.stats_min;
      }
      if (row.stats_max !== null && row.stats_max !== undefined) {
        if (cur.max === null || String(row.stats_max) > String(cur.max))
          cur.max = row.stats_max;
      }
      colStats.set(row.path_in_schema, cur);
    }
    const rowCount = [...rowGroups.values()].reduce((sum, n) => sum + n, 0);
    return { rowCount, numRowGroups: rowGroups.size, colStats };
  }

  /**
   * Footer-only metadata for one file: row count, row groups, column
   * schema, per-column null/min/max and the min/max of the primary
   * timestamp column. Never touches row data.
   */
  async function fetchFileMeta(name, stat) {
    const abs = path.join(dir, name);
    const metadata = await run(
      db,
      `SELECT path_in_schema, type, row_group_id, row_group_num_rows, stats_min, stats_max, stats_null_count
			 FROM parquet_metadata(${sqlString(abs)})`,
    );
    const schema = await run(
      db,
      `SELECT name, type, num_children FROM parquet_schema(${sqlString(abs)})`,
    );

    const { rowCount, numRowGroups, colStats } = aggregateMetadata(metadata);
    const columns = schema
      .filter(
        (c) =>
          c.name && (c.num_children === null || Number(c.num_children) === 0),
      )
      .map((c) => ({ name: c.name, type: c.type }));

    // Primary timestamp column: prefer the Databento event clock, else any
    // timestamp-typed column. Drives the min/max ts shown on the file cards.
    const tsColumn =
      columns.find((c) => c.name === "ts_event") ||
      columns.find((c) => /timestamp/i.test(c.type || ""));
    let minTs = null;
    let maxTs = null;
    if (tsColumn) {
      const tsStats = colStats.get(tsColumn.name);
      if (tsStats) {
        minTs = tsStats.min;
        maxTs = tsStats.max;
      }
    }

    return {
      name,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      rowCount,
      numRowGroups,
      numColumns: columns.length,
      columns,
      minTs,
      maxTs,
      colStats,
    };
  }

  /** GET /api/files — cached listing; invalidated when file mtimes change. */
  async function listFiles() {
    await pragmaReady;
    const names = parquetFileNames();
    const signature = names
      .map((n) => `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`)
      .join("|");
    if (listingCache.signature === signature && listingCache.data) {
      return listingCache.data;
    }

    const files = [];
    for (const name of names) {
      const stat = statOf(path.join(dir, name), name);
      const meta = await fetchFileMeta(name, stat);
      files.push({
        name: meta.name,
        sizeBytes: meta.sizeBytes,
        mtime: meta.mtime,
        rowCount: meta.rowCount,
        numRowGroups: meta.numRowGroups,
        numColumns: meta.numColumns,
        columns: meta.columns,
        minTs: meta.minTs,
        maxTs: meta.maxTs,
      });
    }
    listingCache = { signature, data: { files } };
    return listingCache.data;
  }

  /**
   * Approximate distinct counts per column over a Bernoulli sample.
   *
   * The sample is applied as a streaming operator above the scan (per-row),
   * so memory stays O(columns) regardless of file size — unlike a reservoir
   * sample, which materializes the full sampled rows (2M rows of MBO data
   * exceeded the 2 GiB container cap and OOM-killed the process). The scan
   * itself reads the whole file, so the percentage is capped small
   * (`sampleTargetRows`-ish rows) to bound I/O.
   */
  async function sampleDistinct(abs, columns, samplePct) {
    const exprs = columns
      .map(
        (c) =>
          `approx_count_distinct(CAST(${sqlIdent(c.name)} AS VARCHAR)) AS ${sqlIdent("__d_" + c.name)}`,
      )
      .join(", ");
    const sampleClause =
      samplePct !== null
        ? ` USING SAMPLE ${samplePct} PERCENT (bernoulli)`
        : "";
    const rows = await run(
      db,
      `SELECT count(*) AS __n, ${exprs} FROM read_parquet(${sqlString(abs)})${sampleClause}`,
    );
    const row = rows[0] || {};
    const out = { sampleN: Number(row.__n) || 0 };
    for (const c of columns) {
      const v = row[`__d_${c.name}`];
      out[c.name] = typeof v === "bigint" ? Number(v) : (v ?? 0);
    }
    return out;
  }

  /** GET /api/profile?file=<name> — footer stats + sampled distinct, cached per file+mtime. */
  async function getProfile(name) {
    assertSafeFileName(name);
    const abs = path.join(dir, name);
    const stat = statOf(abs, name);
    const cached = profileCache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }
    await pragmaReady;

    const meta = await fetchFileMeta(name, stat);
    const { columns, rowCount, colStats } = meta;

    // Sample only when the file is large; otherwise scan everything. The
    // percentage targets ~sampleTargetRows rows but is capped at 0.5% so a
    // mid-size file never triggers a big scan either (see OOM memo).
    const sampled = rowCount > sampleTargetRows;
    const samplePct = sampled
      ? Math.min(0.5, Number(((sampleTargetRows / rowCount) * 100).toFixed(4)))
      : null;
    const distinct = await sampleDistinct(abs, columns, samplePct);

    const profileColumns = columns.map((c) => {
      const st = colStats.get(c.name) || { nullCount: 0, min: null, max: null };
      return {
        name: c.name,
        type: c.type,
        nullCount: st.nullCount,
        nullPct: rowCount > 0 ? round2((st.nullCount / rowCount) * 100) : 0,
        min: st.min,
        max: st.max,
        distinctApprox: distinct[c.name],
        sampleN: distinct.sampleN,
      };
    });

    const data = {
      file: name,
      rowCount,
      columns: profileColumns,
      sampled,
      generatedAt: new Date().toISOString(),
    };
    profileCache.set(abs, { mtimeMs: stat.mtimeMs, data });
    return data;
  }

  /** GET /api/preview?file=<name>&limit=<n> — first rows via LIMIT pushdown. */
  async function getPreview(name, limit = 20) {
    assertSafeFileName(name);
    const abs = path.join(dir, name);
    const stat = statOf(abs, name);
    await pragmaReady;
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    const key = `${abs}:${n}`;
    const cached = previewCache.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }

    const rows = await run(
      db,
      `SELECT * FROM read_parquet(${sqlString(abs)}) LIMIT ${n}`,
    );
    let columns;
    if (rows.length > 0) {
      columns = Object.keys(rows[0]);
    } else {
      const schema = await run(
        db,
        `SELECT name FROM parquet_schema(${sqlString(abs)})`,
      );
      columns = schema
        .filter((c) => c.name && c.name !== "duckdb_schema")
        .map((c) => c.name);
    }
    const data = {
      file: name,
      columns,
      rows: rows.map((r) => columns.map((c) => normalizeValue(r[c]))),
      limit: n,
    };
    previewCache.set(key, { mtimeMs: stat.mtimeMs, data });
    return data;
  }

  return { listFiles, getProfile, getPreview };
}

/** Shared singleton used by the API routes (tests build their own). */
export const store = createParquetStore();
