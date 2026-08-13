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
  let store;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parquet-peek-test-"));
    db = new duckdb.Database(":memory:");

    // Create fixture table with varied types & nulls
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

    // Tiny second file
    await run(
      db,
      `COPY (SELECT 1 AS col_a) TO '${path.join(tmpDir, "tiny.parquet").replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );

    // Empty parquet file (0 rows)
    await run(
      db,
      `COPY (SELECT 1 AS col_empty WHERE false) TO '${path.join(tmpDir, "empty.parquet").replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );

    store = createParquetStore(tmpDir, db, { sampleTargetRows: 500 });
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("listFiles lists parquet files sorted with metadata and caches results", async () => {
    const res1 = await store.listFiles();
    expect(res1.files).toHaveLength(3);
    expect(res1.files.map((f) => f.name)).toEqual([
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
    const res2 = await store.listFiles();
    expect(res2).toBe(res1);
  });

  it("getProfile computes column metrics for non-sampled and sampled files", async () => {
    // fixture.parquet has 1000 rows > sampleTargetRows (500) -> sampled = true
    const prof = await store.getProfile("fixture.parquet");
    expect(prof.file).toBe("fixture.parquet");
    expect(prof.rowCount).toBe(1000);
    expect(prof.sampled).toBe(true);
    expect(prof.columns).toHaveLength(7);

    const priceCol = prof.columns.find((c) => c.name === "price");
    expect(priceCol.nullCount).toBe(500);
    expect(priceCol.nullPct).toBe(50);
    expect(priceCol.min).not.toBeNull();
    expect(priceCol.max).not.toBeNull();
    expect(priceCol.distinctApprox).toBeGreaterThan(0);

    // Cached profile call
    const profCached = await store.getProfile("fixture.parquet");
    expect(profCached).toBe(prof);

    // tiny.parquet has 1 row <= sampleTargetRows (500) -> sampled = false
    const tinyProf = await store.getProfile("tiny.parquet");
    expect(tinyProf.sampled).toBe(false);
  });

  it("getPreview returns top N rows and supports limits and empty files", async () => {
    const prev = await store.getPreview("fixture.parquet", 10);
    expect(prev.file).toBe("fixture.parquet");
    expect(prev.limit).toBe(10);
    expect(prev.columns).toContain("symbol");
    expect(prev.rows).toHaveLength(10);
    expect(prev.rows[0][0]).toBe("AAPL");

    // Limit clamping
    const clampedPrev = await store.getPreview("fixture.parquet", 500);
    expect(clampedPrev.limit).toBe(100);

    // Default limit when invalid
    const defaultPrev = await store.getPreview("fixture.parquet", "invalid");
    expect(defaultPrev.limit).toBe(20);

    // Empty file preview
    const emptyPrev = await store.getPreview("empty.parquet", 10);
    expect(emptyPrev.rows).toHaveLength(0);
    expect(emptyPrev.columns).toEqual(["col_empty"]);
  });

  it("throws 404 for missing file and 500 for invalid directory", async () => {
    await expect(store.getProfile("nonexistent.parquet")).rejects.toThrow(
      ParquetPeekError,
    );

    const badStore = createParquetStore("/path/does/not/exist/12345", db);
    await expect(badStore.listFiles()).rejects.toThrow(ParquetPeekError);
  });
});
