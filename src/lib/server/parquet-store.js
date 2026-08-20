// parquet-store.js — read-only access to the parquet directory (server-only).
//
// Two-tier access model (see memos/parquet-peek-implementation):
//   - Manifest (metadata fast path): parquet_metadata + parquet_schema footers,
//     no data scan — instant even for multi-GB files.
//   - Profile (on-demand, cached): footer stats for null/min/max plus
//     approx_count_distinct() over a LIMIT-bounded slice (~1M rows).
//   - Preview: SELECT * ... LIMIT n (row-group pushdown, sub-second).
//
// All reads are metadata/limited-scan only; the data mount is read-only.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  decodeFilename,
  describeColumn,
  isNumericType,
  isVarcharType,
} from "../dictionary.js";
import { buildHighlights } from "../highlights.js";

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
        // Serialize every query through one promise chain: the duckdb node
        // binding is not safe for two in-flight calls on the same Database
        // (concurrent profile+preview+highlights requests used to overlap
        // and crash the worker with a native Napi::Error). Queries are
        // cheap to queue — the worker is single-threaded anyway.
        let queue = Promise.resolve();
        parentPort.on("message", (msg) => {
          if (msg.shutdown) {
            // Graceful teardown: drain the queue, then close duckdb cleanly
            // (db.close avoids the native Napi::Error that worker.terminate()
            // throws when a callback is still pending). The main thread
            // terminates the (now idle) worker after this message.
            queue = queue.then(
              () =>
                new Promise((resolve) => {
                  db.close(() => {
                    parentPort.postMessage({ type: "closed" });
                    resolve();
                  });
                }),
            );
            return;
          }
          queue = queue.then(
            () =>
              new Promise((resolve) => {
                const finish = (e, result) => {
                  parentPort.postMessage(
                    e
                      ? { id: msg.id, ok: false, error: e.message }
                      : { id: msg.id, ok: true, rows: result },
                  );
                  resolve();
                };
                if (msg.exec) db.exec(msg.sql, (e) => finish(e, null));
                else db.all(msg.sql, (e, r) => finish(e, r));
              }),
          );
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
    if (!w) return;
    // Ask the worker to close duckdb cleanly first; only force-terminate if
    // it doesn't respond (native Napi::Error risk when killing mid-callback).
    let terminated = false;
    const force = setTimeout(() => {
      if (!terminated) {
        terminated = true;
        w.terminate().catch(() => {});
      }
    }, 5000);
    w.once("message", (msg) => {
      if (msg.type === "closed") {
        if (!terminated) {
          terminated = true;
          clearTimeout(force);
          w.terminate().catch(() => {});
        }
      }
    });
    try {
      w.postMessage({ shutdown: true });
    } catch {
      if (!terminated) {
        terminated = true;
        clearTimeout(force);
        w.terminate().catch(() => {});
      }
    }
  }

  /** DuckDB memory settings as applied inside the worker. */
  async function getSettings() {
    await ensureWorker();
    return settings;
  }

  let listingCache = { signature: null, data: null };
  const profileCache = new Map();
  const previewCache = new Map();
  const highlightsCache = new Map();

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
      tsColumnName: tsColumn?.name ?? null,
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
   * Approximate distinct counts per column over a LIMIT-bounded slice,
   * optionally plus the median (approx_quantile) of selected columns.
   *
   * The subquery form pushes the LIMIT into the parquet scan, so only the
   * first ~sampleLimit rows are read (~1 row group ≈ 16 MB for the big file)
   * instead of a full 5.8 GB scan. A full scan is what filled the container's
   * cgroup (page cache / buffers) and got it OOM-killed at 2 GiB on the NAS,
   * even though Bernoulli sampling itself is memory-flat. The result is one
   * aggregated row (count + one HLL per column) — never table rows.
   */
  async function sampleDistinct(abs, columns, sampleLimit, medianCols = []) {
    const exprs = columns.map(
      (c) =>
        `approx_count_distinct(${sqlIdent(c.name)}) AS ${sqlIdent("__d_" + c.name)}`,
    );
    for (const name of medianCols) {
      exprs.push(
        `approx_quantile(${sqlIdent(name)}, 0.5) AS ${sqlIdent("__m_" + name)}`,
      );
    }
    const sql =
      sampleLimit !== null
        ? `SELECT count(*) AS __n, ${exprs.join(", ")} FROM (
             SELECT * FROM read_parquet(${sqlString(abs)}) LIMIT ${sampleLimit}
           )`
        : `SELECT count(*) AS __n, ${exprs.join(", ")} FROM read_parquet(${sqlString(abs)})`;
    const rows = await query(sql);
    const row = rows[0] || {};
    const out = { sampleN: Number(row.__n) || 0, medians: {} };
    for (const c of columns) {
      const v = row[`__d_${c.name}`];
      out[c.name] = typeof v === "bigint" ? Number(v) : (v ?? 0);
    }
    for (const name of medianCols) {
      const v = row[`__m_${name}`];
      out.medians[name] =
        v === null || v === undefined
          ? null
          : typeof v === "bigint"
            ? Number(v)
            : v;
    }
    return out;
  }

  /** Top-N values of a column over the same LIMIT-bounded slice. */
  async function sampleTopN(abs, col, sampleLimit, limit = 5) {
    const src =
      sampleLimit !== null
        ? `(SELECT * FROM read_parquet(${sqlString(abs)}) LIMIT ${sampleLimit})`
        : `read_parquet(${sqlString(abs)})`;
    const rows = await query(
      `SELECT ${sqlIdent(col)} AS __v, count(*) AS __c FROM ${src}
			 GROUP BY ${sqlIdent(col)} ORDER BY __c DESC LIMIT ${limit}`,
    );
    return rows.map((r) => ({
      value: normalizeValue(r.__v),
      count: Number(r.__c),
    }));
  }

  /**
   * DuckDB logical types per column (e.g. TIMESTAMP, VARCHAR, DOUBLE) read at
   * query time. parquet_schema reports physical storage types (INT64,
   * BYTE_ARRAY, FIXED_LEN_BYTE_ARRAY) which are misleading for deciding what
   * we can safely aggregate, so we ask DuckDB directly. Returns null for an
   * empty file (0 rows → typeof returns nothing); callers fall back.
   */
  async function logicalTypes(abs, slice, columns) {
    const exprs = columns
      .map((c) => `typeof(${sqlIdent(c.name)}) AS ${sqlIdent("__t_" + c.name)}`)
      .join(", ");
    const rows = await query(`SELECT ${exprs} FROM ${slice} LIMIT 1`);
    const row = rows[0];
    if (!row) return null;
    const map = new Map();
    for (const c of columns) {
      const v = row[`__t_${c.name}`];
      map.set(c.name, typeof v === "string" ? v : String(v ?? ""));
    }
    return map;
  }

  /** Bounded read slice used by profile/highlights; LIMIT pushdown caps I/O. */
  function sliceOf(abs, sampleLimit) {
    return sampleLimit !== null
      ? `(SELECT * FROM read_parquet(${sqlString(abs)}) LIMIT ${sampleLimit})`
      : `read_parquet(${sqlString(abs)})`;
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
    // LIMIT caps the scan to ~sampleTargetRows rows (memo: ~1M for the 361M
    // file) via parquet LIMIT pushdown — bounded I/O, never a full scan.
    const sampled = rowCount > sampleTargetRows;
    const sampleLimit = sampled ? Math.min(sampleTargetRows, rowCount) : null;
    const t0 = Date.now();

    // Role + meaning per column (glossary → heuristics), and which columns
    // deserve extra stats: medians for price-like columns, top-N for
    // categorical ones (known categories, or low-cardinality strings).
    // Logical types come from a typeof() query, not parquet_schema (which
    // reports physical storage types like INT64/BYTE_ARRAY).
    const roles = new Map(
      columns.map((c) => [c.name, describeColumn(c.name, c.type)]),
    );
    const slice = sliceOf(abs, sampleLimit);
    const types =
      (await logicalTypes(abs, slice, columns)) ??
      new Map(columns.map((c) => [c.name, c.type]));
    const medianCols = columns
      .filter(
        (c) =>
          roles.get(c.name).role === "price" &&
          isNumericType(types.get(c.name)),
      )
      .map((c) => c.name);
    const distinct = await sampleDistinct(
      abs,
      columns,
      sampleLimit,
      medianCols,
    );
    if (sampled && distinct.sampleN === 0) {
      console.warn(
        `[profile] ${name}: LIMIT slice produced 0 rows — check the query; the slice must not be empty`,
      );
    }
    const categoryCols = columns
      .filter(
        (c) =>
          roles.get(c.name).role === "category" ||
          (isVarcharType(types.get(c.name)) &&
            Number(distinct[c.name] ?? 0) <= 100),
      )
      .slice(0, 5);
    const topN = {};
    for (const c of categoryCols) {
      topN[c.name] = await sampleTopN(abs, c.name, sampleLimit, 5);
    }
    console.log(
      `[profile] ${name} rows=${rowCount} sampled=${sampled} limit=${sampleLimit} sampleN=${distinct.sampleN} topN=${categoryCols.length} elapsed=${Date.now() - t0}ms`,
    );

    const profileColumns = columns.map((c) => {
      const st = colStats.get(c.name) || { nullCount: 0, min: null, max: null };
      const role = roles.get(c.name);
      const col = {
        name: c.name,
        type: types.get(c.name) || c.type,
        role: role.role,
        meaning: role.meaning,
        unit: role.unit,
        nullCount: st.nullCount,
        nullPct: rowCount > 0 ? round2((st.nullCount / rowCount) * 100) : 0,
        min: st.min,
        max: st.max,
        distinctApprox: distinct[c.name],
        sampleN: distinct.sampleN,
      };
      if (medianCols.includes(c.name)) {
        col.median = distinct.medians[c.name] ?? null;
      }
      if (topN[c.name]) {
        col.top = topN[c.name].map((t) => ({
          ...t,
          pct:
            distinct.sampleN > 0
              ? round2((t.count / distinct.sampleN) * 100)
              : 0,
        }));
      }
      return col;
    });

    const data = {
      file: name,
      rowCount,
      sizeBytes: stat.size,
      columns: profileColumns,
      sampled,
      generatedAt: new Date().toISOString(),
    };
    profileCache.set(abs, { mtimeMs: stat.mtimeMs, data });
    return data;
  }

  /**
   * GET /api/highlights?file=<name> — plain-language TL;DR + notebook
   * questions, from bounded sampled aggregates (cached per file+mtime).
   *
   * Runs a handful of LIMIT-pushdown queries over the same slice the profile
   * uses: scalars (count, symbol cardinality, price quantiles, size sum),
   * top symbols, busiest hours, and top-N for categorical columns. The
   * sentence-building itself lives in src/lib/highlights.js (pure).
   */
  async function getHighlights(name) {
    assertSafeFileName(name);
    const abs = path.join(dir, name);
    const stat = statOf(abs, name);
    const cached = highlightsCache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }

    const meta = await fetchFileMeta(name, stat);
    const { columns, rowCount, colStats } = meta;

    const sampled = rowCount > sampleTargetRows;
    const sampleLimit = sampled ? Math.min(sampleTargetRows, rowCount) : null;
    const slice = sliceOf(abs, sampleLimit);

    const roles = new Map(
      columns.map((c) => [c.name, describeColumn(c.name, c.type)]),
    );
    const types =
      (await logicalTypes(abs, slice, columns)) ??
      new Map(columns.map((c) => [c.name, c.type]));
    const symCol =
      columns.find((c) => roles.get(c.name).role === "symbol")?.name ?? null;
    const pxCol =
      columns.find(
        (c) =>
          roles.get(c.name).role === "price" &&
          isNumericType(types.get(c.name)),
      )?.name ?? null;
    const sizeCol =
      columns.find(
        (c) =>
          roles.get(c.name).role === "size" && isNumericType(types.get(c.name)),
      )?.name ?? null;
    const tsCol =
      meta.tsColumnName ??
      columns.find((c) => roles.get(c.name).role === "timestamp")?.name ??
      null;

    // Scalar aggregates over the slice (one row, never table rows).
    const sel = ["count(*) AS __n"];
    if (symCol)
      sel.push(`approx_count_distinct(${sqlIdent(symCol)}) AS __n_sym`);
    if (pxCol) {
      sel.push(
        `approx_quantile(${sqlIdent(pxCol)}, 0.05) AS __px05`,
        `approx_quantile(${sqlIdent(pxCol)}, 0.5) AS __px50`,
        `approx_quantile(${sqlIdent(pxCol)}, 0.95) AS __px95`,
      );
    }
    if (sizeCol) sel.push(`sum(${sqlIdent(sizeCol)}) AS __sum_size`);
    const scalarRows = await query(`SELECT ${sel.join(", ")} FROM ${slice}`);
    const s = scalarRows[0] || {};
    const n = Number(s.__n) || 0;
    const num = (v) => (v === null || v === undefined ? 0 : Number(v));

    // Top symbols.
    let topSymbols = [];
    if (symCol && n > 0) {
      const r = await query(
        `SELECT ${sqlIdent(symCol)} AS __v, count(*) AS __c FROM ${slice}
				 GROUP BY ${sqlIdent(symCol)} ORDER BY __c DESC LIMIT 5`,
      );
      topSymbols = r.map((x) => ({
        value: normalizeValue(x.__v),
        count: Number(x.__c),
      }));
    }

    // Busiest hours (UTC) — only when the column is a genuine timestamp type
    // at read time (parquet_schema would report INT64/BYTE_ARRAY here).
    let hours = [];
    if (tsCol && /TIMESTAMP|DATETIME|DATE/i.test(types.get(tsCol) ?? "")) {
      const r = await query(
        `SELECT CAST(datepart('hour', ${sqlIdent(tsCol)}) AS INTEGER) AS __h, count(*) AS __c
				 FROM ${slice} GROUP BY 1 ORDER BY __c DESC LIMIT 3`,
      );
      hours = r.map((x) => ({ hour: Number(x.__h), count: Number(x.__c) }));
    }

    // Categorical mixes (side, action, rtype, …) — max 3 columns.
    const catCols = columns
      .filter((c) => roles.get(c.name).role === "category")
      .slice(0, 3);
    const categoryTops = [];
    for (const c of catCols) {
      if (n === 0) break;
      const r = await query(
        `SELECT ${sqlIdent(c.name)} AS __v, count(*) AS __c FROM ${slice}
				 GROUP BY ${sqlIdent(c.name)} ORDER BY __c DESC LIMIT 5`,
      );
      categoryTops.push({
        column: c.name,
        values: r.map((x) => ({
          value: normalizeValue(x.__v),
          count: Number(x.__c),
        })),
      });
    }

    const pxStats = pxCol
      ? {
          min: colStats.get(pxCol)?.min ?? null,
          max: colStats.get(pxCol)?.max ?? null,
          p05: s.__px05 ?? null,
          p50: s.__px50 ?? null,
          p95: s.__px95 ?? null,
        }
      : null;

    const { bullets, questions } = buildHighlights({
      decoded: decodeFilename(name),
      rowCount,
      sampled,
      sampleN: n,
      minTs: meta.minTs,
      maxTs: meta.maxTs,
      symCol,
      nSymbols: symCol ? num(s.__n_sym) : null,
      topSymbols,
      pxCol,
      pxStats,
      sizeCol,
      sumSize: sizeCol ? num(s.__sum_size) : null,
      hours,
      categoryTops,
    });

    const data = {
      file: name,
      rowCount,
      sampled,
      sampleN: n,
      bullets,
      questions,
      generatedAt: new Date().toISOString(),
    };
    highlightsCache.set(abs, { mtimeMs: stat.mtimeMs, data });
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

  return {
    listFiles,
    getProfile,
    getPreview,
    getHighlights,
    close,
    getSettings,
  };
}

/** Shared singleton used by the API routes (tests build their own). */
export const store = createParquetStore();
