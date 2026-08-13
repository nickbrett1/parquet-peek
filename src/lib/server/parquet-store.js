// parquet-store.js — read-only access to the parquet directory (server-only).
//
// Two-tier access model (see memos/parquet-peek-implementation):
//   - Manifest (metadata fast path): parquet_metadata + parquet_schema footers,
//     no data scan — instant even for multi-GB files.
//   - Profile (on-demand, cached): footer stats for null/min/max plus
//     approx_count_distinct() over a Bernoulli % sample (~1M rows).
//   - Preview: SELECT * ... LIMIT n (row-group pushdown, sub-second).
//
// All reads are metadata/limited-scan only; the data mount is read-only.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
// Path to the duckdb package so the worker thread can require() it without
// relying on cwd. The worker owns the only duckdb Database instance.
const DUCKDB_PATH = require.resolve("duckdb");

/** Hard cap for any single duckdb query — a stuck query is killed, never hung. */
const QUERY_TIMEOUT_MS = 300_000;

/**
 * Worker-thread DuckDB runner. DuckDB's node binding executes queries
 * synchronously on the calling thread, so a big-file scan (30–90 s on the
 * NAS) would block the whole HTTP server. Running it in a worker keeps the
 * main event loop free; a timeout terminates the worker so nothing can ever
 * block or accumulate memory forever.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const duckdb = require(workerData.duckdbPath);
const db = new duckdb.Database(":memory:");
// DuckDB cannot see the container cgroup (defaults to 80% of host RAM and
// never spills), so cap its memory and give it a spill directory — it
// degrades to disk instead of OOM-killing the container (see OOM memos).
db.exec("PRAGMA memory_limit='1GB'", () => {
  db.exec("PRAGMA temp_directory='/tmp'", () => {
    db.all(
      "SELECT current_setting('memory_limit') AS ml, current_setting('temp_directory') AS td",
      (err, rows) => {
        if (err) {
          return parentPort.postMessage({ type: "ready", ok: false, error: err.message });
        }
        parentPort.postMessage({
          type: "ready",
          ok: true,
          memoryLimit: rows[0].ml,
          tempDirectory: rows[0].td,
        });
        parentPort.on("message", (msg) => {
          const finish = (e, result) =>
            parentPort.postMessage(
              e
                ? { id: msg.id, ok: false, error: e.message }
                : { id: msg.id, ok: true, rows: result },
            );
          if (msg.exec) db.exec(msg.sql, (e) => finish(e, null));
          else db.all(msg.sql, (e, r) => finish(e, r));
        });
      },
    );
  });
});
`;

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
 * Create a store bound to a directory. All duckdb work runs in a dedicated
 * worker thread so long scans never block the HTTP server. Call `close()` to
 * terminate the worker (tests), otherwise it lives for the process lifetime.
 */
export function createParquetStore(dir = PARQUET_DIR, options = {}) {
  const sampleTargetRows =
    options.sampleTargetRows ?? DEFAULT_SAMPLE_TARGET_ROWS;

  // Worker-thread plumbing: lazy spawn on first query; one worker per store
  // (each owns its own in-memory duckdb Database + memory pragmas).
  let worker = null;
  let workerReady = null;
  let nextId = 0;
  let settings = null;
  const pending = new Map();

  function failAllPending(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function ensureWorker() {
    if (!worker) {
      const w = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { duckdbPath: DUCKDB_PATH },
      });
      worker = w;
      workerReady = new Promise((resolve, reject) => {
        w.on("message", (msg) => {
          if (msg.type === "ready") {
            if (msg.ok) {
              settings = {
                memoryLimit: msg.memoryLimit,
                tempDirectory: msg.tempDirectory,
              };
              resolve();
            } else {
              reject(
                new ParquetPeekError(
                  500,
                  `duckdb worker init failed: ${msg.error}`,
                ),
              );
            }
            return;
          }
          const p = pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.rows ?? []);
          else
            p.reject(
              new ParquetPeekError(500, msg.error || "duckdb query failed"),
            );
        });
        w.on("error", (err) => {
          if (worker === w) worker = null;
          failAllPending(
            new ParquetPeekError(500, `duckdb worker error: ${err.message}`),
          );
        });
        w.on("exit", (code) => {
          if (code !== 0 && worker === w) {
            worker = null;
            failAllPending(
              new ParquetPeekError(500, `duckdb worker exited (${code})`),
            );
          }
        });
      });
    }
    return workerReady;
  }

  /** Reject every in-flight query and kill the (possibly stuck) worker. */
  function onQueryTimeout() {
    const err = new ParquetPeekError(
      504,
      `duckdb query timed out after ${QUERY_TIMEOUT_MS}ms`,
    );
    failAllPending(err);
    const w = worker;
    worker = null;
    if (w) w.terminate().catch(() => {});
  }

  /**
   * Run a SQL statement in the worker and await its rows. If a query exceeds
   * the timeout the worker is terminated (nothing keeps running or growing)
   * and every in-flight request fails fast; the next call respawns it.
   */
  async function query(sql) {
    await ensureWorker();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(onQueryTimeout, QUERY_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, sql });
    });
  }

  /** Terminate the worker (tests / shutdown). */
  function close() {
    failAllPending(new ParquetPeekError(500, "store closed"));
    const w = worker;
    worker = null;
    workerReady = null;
    if (w) w.terminate().catch(() => {});
  }

  /** DuckDB memory settings as applied inside the worker. */
  async function getSettings() {
    await ensureWorker();
    return settings;
  }

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
    const metadata = await query(
      `SELECT path_in_schema, type, row_group_id, row_group_num_rows, stats_min, stats_max, stats_null_count
			 FROM parquet_metadata(${sqlString(abs)})`,
    );
    const schema = await query(
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
   * The sample is a streaming operator above the scan (per-row), so memory
   * stays O(columns) regardless of file size. The CTE keeps the sample
   * visible to the optimizer (it cannot be eliminated) and the percentage is
   * sized to ~sampleTargetRows rows, bounding both memory and I/O. This is
   * the OOM-memo's prescribed shape: one pass, all columns, HLL.
   */
  async function sampleDistinct(abs, columns, samplePct) {
    const exprs = columns
      .map(
        (c) =>
          `approx_count_distinct(${sqlIdent(c.name)}) AS ${sqlIdent("__d_" + c.name)}`,
      )
      .join(", ");
    const sql =
      samplePct !== null
        ? `WITH sampled AS (
             SELECT * FROM read_parquet(${sqlString(abs)})
             USING SAMPLE ${samplePct} PERCENT (bernoulli)
           )
           SELECT count(*) AS __n, ${exprs} FROM sampled`
        : `SELECT count(*) AS __n, ${exprs} FROM read_parquet(${sqlString(abs)})`;
    const rows = await query(sql);
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

    const meta = await fetchFileMeta(name, stat);
    const { columns, rowCount, colStats } = meta;

    // Sample only when the file is large; otherwise scan everything. The
    // percentage targets ~sampleTargetRows rows (memo: 1M/361M ≈ 0.28%).
    const sampled = rowCount > sampleTargetRows;
    const samplePct = sampled
      ? Number(((sampleTargetRows / rowCount) * 100).toFixed(4))
      : null;
    const t0 = Date.now();
    const distinct = await sampleDistinct(abs, columns, samplePct);
    if (sampled && distinct.sampleN === 0) {
      console.warn(
        `[profile] ${name}: Bernoulli sample produced 0 rows (pct=${samplePct}) — check EXPLAIN; the sample must survive the optimizer`,
      );
    }
    console.log(
      `[profile] ${name} rows=${rowCount} sampled=${sampled} pct=${samplePct} sampleN=${distinct.sampleN} elapsed=${Date.now() - t0}ms`,
    );

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
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    const key = `${abs}:${n}`;
    const cached = previewCache.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }

    const rows = await query(
      `SELECT * FROM read_parquet(${sqlString(abs)}) LIMIT ${n}`,
    );
    let columns;
    if (rows.length > 0) {
      columns = Object.keys(rows[0]);
    } else {
      const schema = await query(
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

  return { listFiles, getProfile, getPreview, close, getSettings };
}

/** Shared singleton used by the API routes (tests build their own). */
export const store = createParquetStore();
