import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertSafeFileName,
  createParquetStore,
  normalizeValue,
  ParquetPeekError,
} from "./parquet-store.js";

const require = createRequire(import.meta.url);
const duckdb = require("duckdb");

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

describe("assertSafeFileName", () => {
  it("accepts valid parquet filenames", () => {
    expect(assertSafeFileName("data.parquet")).toBe("data.parquet");
    expect(assertSafeFileName("xnas-itch-20230914.mbo.parquet")).toBe(
      "xnas-itch-20230914.mbo.parquet",
    );
  });

  it("rejects invalid, empty, or path traversal names", () => {
    expect(() => assertSafeFileName("")).toThrow(ParquetPeekError);
    expect(() => assertSafeFileName("   ")).toThrow(ParquetPeekError);
    expect(() => assertSafeFileName(null)).toThrow(ParquetPeekError);
    expect(() => assertSafeFileName(".")).toThrow(ParquetPeekError);
    expect(() => assertSafeFileName("..")).toThrow(ParquetPeekError);
    expect(() => assertSafeFileName("../test.parquet")).toThrow(
      ParquetPeekError,
    );
    expect(() => assertSafeFileName("dir/test.parquet")).toThrow(
      ParquetPeekError,
    );
    expect(() => assertSafeFileName("dir\\test.parquet")).toThrow(
      ParquetPeekError,
    );
    expect(() => assertSafeFileName("test.csv")).toThrow(ParquetPeekError);
  });
});

describe("normalizeValue", () => {
  it("converts BigInt safely", () => {
    expect(normalizeValue(123n)).toBe(123);
    expect(normalizeValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(normalizeValue(9007199254740993n)).toBe("9007199254740993");
  });

  it("converts Date to ISO string", () => {
    const d = new Date("2024-08-05T13:30:00.000Z");
    expect(normalizeValue(d)).toBe("2024-08-05T13:30:00.000Z");
  });

  it("converts Uint8Array to base64", () => {
    const buf = new Uint8Array([104, 101, 108, 108, 111]);
    expect(normalizeValue(buf)).toBe("aGVsbG8=");
  });

  it("passes through primitives and null", () => {
    expect(normalizeValue("hello")).toBe("hello");
    expect(normalizeValue(42.5)).toBe(42.5);
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue(null)).toBeNull();
  });
});

describe("createParquetStore", () => {
  let tmpDir;
  let db;
  let storeA; // sampleTargetRows 2000 -> fixture.parquet (1000 rows) is NOT sampled
  let storeB; // sampleTargetRows 500 -> big-fixture.parquet (500K rows) IS sampled

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parquet-peek-test-"));
    db = new duckdb.Database(":memory:");

    // Small fixture with varied types & nulls (single row group).
    await run(
      db,
      `CREATE TABLE ticks AS SELECT
				'AAPL' AS symbol,
				CASE WHEN i % 2 = 0 THEN 100.0 + (i % 5) * 0.5 ELSE NULL END AS price,
				CAST((i % 7) * 100 AS INTEGER) AS size,
				CAST(i * 1000 AS BIGINT) AS seq,
				TIMESTAMP '2024-08-05 13:30:00' + (i * INTERVAL 1 SECOND) AS ts_event,
				i % 3 AS rtype,
				'A' AS action
			FROM range(1000) t(i)`,
    );

    await run(
      db,
      `COPY ticks TO '${path.join(tmpDir, "fixture.parquet").replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );

    // Large fixture with MANY row groups (50) so the Bernoulli sample is
    // applied per-row (streaming) rather than whole-row-group-or-nothing.
    await run(
      db,
      `CREATE TABLE big AS SELECT
				i AS sequence,
				CASE WHEN i % 2 = 0 THEN 100.0 + (i % 5) * 0.5 ELSE NULL END AS price,
				(i % 7) * 100 AS size,
				CAST(i * 1000 AS BIGINT) AS seq,
				TIMESTAMP '2024-08-05 13:30:00' + (i * INTERVAL 1 SECOND) AS ts_event,
				'SYM' || (i % 50) AS symbol,
				i % 3 AS rtype
			FROM range(500000) t(i)`,
    );

    await run(
      db,
      `COPY big TO '${path.join(tmpDir, "big-fixture.parquet").replace(/'/g, "''")}' (FORMAT PARQUET, ROW_GROUP_SIZE 10000)`,
    );

    // Tiny file
    await run(
      db,
      `COPY (SELECT 1 AS col_a) TO '${path.join(tmpDir, "tiny.parquet").replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );

    // Empty parquet file (0 rows)
    await run(
      db,
      `COPY (SELECT 1 AS col_empty WHERE false) TO '${path.join(tmpDir, "empty.parquet").replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );

    storeA = createParquetStore(tmpDir, { sampleTargetRows: 2000 });
    storeB = createParquetStore(tmpDir, { sampleTargetRows: 500 });
  });

  afterAll(async () => {
    await storeA?.close();
    await storeB?.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("listFiles lists parquet files sorted with metadata and caches results", async () => {
    const res1 = await storeA.listFiles();
    expect(res1.files).toHaveLength(4);
    expect(res1.files.map((f) => f.name)).toEqual([
      "big-fixture.parquet",
      "empty.parquet",
      "fixture.parquet",
      "tiny.parquet",
    ]);

    const fix = res1.files.find((f) => f.name === "fixture.parquet");
    expect(fix.rowCount).toBe(1000);
    expect(fix.numRowGroups).toBeGreaterThanOrEqual(1);
    expect(fix.numColumns).toBe(7);
    expect(fix.minTs).not.toBeNull();
    expect(fix.maxTs).not.toBeNull();

    // Second call returns cached result
    const res2 = await storeA.listFiles();
    expect(res2).toBe(res1);
  });

  it("getProfile on a small file scans everything (sampled=false)", async () => {
    // fixture.parquet has 1000 rows <= sampleTargetRows (2000) -> full scan
    const prof = await storeA.getProfile("fixture.parquet");
    expect(prof.file).toBe("fixture.parquet");
    expect(prof.rowCount).toBe(1000);
    expect(prof.sampled).toBe(false);
    expect(prof.columns).toHaveLength(7);

    const priceCol = prof.columns.find((c) => c.name === "price");
    expect(priceCol.nullCount).toBe(500);
    expect(priceCol.nullPct).toBe(50);
    expect(priceCol.min).not.toBeNull();
    expect(priceCol.max).not.toBeNull();
    expect(priceCol.distinctApprox).toBeGreaterThan(0);
    // Full scan -> sampleN equals row count
    expect(priceCol.sampleN).toBe(1000);

    // Cached profile call returns the same object
    const profCached = await storeA.getProfile("fixture.parquet");
    expect(profCached).toBe(prof);

    // tiny.parquet has 1 row -> also not sampled
    const tinyProf = await storeA.getProfile("tiny.parquet");
    expect(tinyProf.sampled).toBe(false);
  });

  it("getProfile on a large file uses a bounded Bernoulli sample (sampled=true)", async () => {
    // big-fixture.parquet has 500K rows > sampleTargetRows (500) -> sampled.
    // pct = min(0.5, 500/500000*100) = 0.1% -> ~500 rows expected.
    const prof = await storeB.getProfile("big-fixture.parquet");
    expect(prof.sampled).toBe(true);
    expect(prof.rowCount).toBe(500000);

    const priceCol = prof.columns.find((c) => c.name === "price");
    expect(priceCol.nullCount).toBe(250000);
    expect(priceCol.nullPct).toBe(50);
    expect(priceCol.distinctApprox).toBeGreaterThan(0);
    // Bernoulli sample: ~0.1% of 500K rows, streaming per-row on a 50-group
    // file. Assert a sane bounded range (never 0, never the whole file).
    expect(priceCol.sampleN).toBeGreaterThan(0);
    expect(priceCol.sampleN).toBeLessThan(50000);
  });

  it("getPreview returns top N rows and supports limits and empty files", async () => {
    const prev = await storeA.getPreview("fixture.parquet", 10);
    expect(prev.file).toBe("fixture.parquet");
    expect(prev.limit).toBe(10);
    expect(prev.columns).toContain("symbol");
    expect(prev.rows).toHaveLength(10);
    expect(prev.rows[0][0]).toBe("AAPL");

    // Limit clamping
    const clampedPrev = await storeA.getPreview("fixture.parquet", 500);
    expect(clampedPrev.limit).toBe(100);

    // Default limit when invalid
    const defaultPrev = await storeA.getPreview("fixture.parquet", "invalid");
    expect(defaultPrev.limit).toBe(20);

    // Empty file preview
    const emptyPrev = await storeA.getPreview("empty.parquet", 10);
    expect(emptyPrev.rows).toHaveLength(0);
    expect(emptyPrev.columns).toEqual(["col_empty"]);
  });

  it("caps duckdb memory so a runaway query spills instead of OOM-killing", async () => {
    const s = await storeA.getSettings();
    expect(s.tempDirectory).toBe("/tmp");
    const mb = Number.parseFloat(s.memoryLimit);
    expect(Number.isFinite(mb)).toBe(true);
    expect(mb).toBeLessThan(2048); // set to 1GB, not the default 80% of host RAM
  });

  it("throws 404 for missing file and 500 for invalid directory", async () => {
    await expect(storeA.getProfile("nonexistent.parquet")).rejects.toThrow(
      ParquetPeekError,
    );

    const badStore = createParquetStore("/path/does/not/exist/12345");
    await expect(badStore.listFiles()).rejects.toThrow(ParquetPeekError);
  });
});
