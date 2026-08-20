import { describe, expect, it } from "vitest";
import {
  COLUMN_GLOSSARY,
  DATASETS,
  decodeFilename,
  describeColumn,
  isNumericType,
  isVarcharType,
  PROTOCOLS,
  VENUES,
} from "./dictionary.js";

describe("describeColumn", () => {
  it("returns glossary meanings for known Databento columns", () => {
    expect(describeColumn("ts_event", "BIGINT").role).toBe("timestamp");
    expect(describeColumn("ts_event", "BIGINT").known).toBe(true);
    expect(describeColumn("action", "VARCHAR").meaning).toContain("A=add");
    expect(describeColumn("side", "VARCHAR").role).toBe("category");
    expect(describeColumn("price", "DOUBLE").role).toBe("price");
    expect(describeColumn("size", "BIGINT").role).toBe("size");
    expect(describeColumn("symbol", "VARCHAR").role).toBe("symbol");
    expect(describeColumn("instrument_id", "BIGINT").role).toBe("id");
    expect(describeColumn("rtype", "BIGINT").role).toBe("category");
  });

  it("falls back to name heuristics for unknown columns", () => {
    expect(describeColumn("last_price", "DOUBLE").role).toBe("price");
    expect(describeColumn("bid_px", "DOUBLE").role).toBe("price");
    expect(describeColumn("trade_qty", "BIGINT").role).toBe("size");
    expect(describeColumn("seq", "BIGINT").role).toBe("id");
    expect(describeColumn("my_ts_recv", "TIMESTAMP").role).toBe("timestamp");
    expect(describeColumn("ticker", "VARCHAR").role).toBe("symbol");
  });

  it("falls back to type-based roles and other", () => {
    expect(describeColumn("whatever", "VARCHAR").role).toBe("text");
    expect(describeColumn("whatever", "BIGINT").role).toBe("numeric");
    expect(describeColumn("whatever", "BLOB").role).toBe("other");
    expect(describeColumn("whatever", "BLOB").meaning).toBeNull();
  });
});

describe("isNumericType / isVarcharType", () => {
  it("recognizes numeric duckdb types", () => {
    for (const t of [
      "BIGINT",
      "INTEGER",
      "DOUBLE",
      "DECIMAL(10,4)",
      "FLOAT",
      "UBIGINT",
    ]) {
      expect(isNumericType(t)).toBe(true);
    }
    expect(isNumericType("VARCHAR")).toBe(false);
    expect(isNumericType(null)).toBe(false);
  });

  it("recognizes varchar-ish types", () => {
    expect(isVarcharType("VARCHAR")).toBe(true);
    expect(isVarcharType("TEXT")).toBe(true);
    expect(isVarcharType("BIGINT")).toBe(false);
  });
});

describe("decodeFilename", () => {
  it("decodes a Databento-style filename", () => {
    const d = decodeFilename("xnas-itch-20230914.mbo.parquet");
    expect(d.matched).toBe(true);
    expect(d.venue).toMatchObject({ code: "xnas", name: "NASDAQ" });
    expect(d.protocol).toMatchObject({ code: "itch", name: "ITCH" });
    expect(d.dataset).toMatchObject({ code: "mbo", name: "Market-by-Order" });
    expect(d.date).toBe("2023-09-14");
    expect(d.unrecognized).toEqual([]);
    expect(d.summary).toContain("NASDAQ");
    expect(d.summary).toContain("ITCH");
    expect(d.summary).toContain("2023-09-14");
    expect(d.summary).toContain("Market-by-Order");
  });

  it("handles venue-protocol-date without a dataset", () => {
    const d = decodeFilename("glbx-mdp3-20240102.parquet");
    expect(d.venue.name).toBe("CME Globex");
    expect(d.protocol.name).toBe("MDP 3.0");
    expect(d.date).toBe("2024-01-02");
    expect(d.matched).toBe(true);
  });

  it("keeps unknown parts in unrecognized and reports unmatched", () => {
    const d = decodeFilename("mystery-file.parquet");
    expect(d.matched).toBe(false);
    expect(d.venue).toBeNull();
    expect(d.unrecognized).toContain("mystery");
  });

  it("is graceful for empty or null input", () => {
    expect(decodeFilename("").matched).toBe(false);
    expect(decodeFilename("").summary).toBeNull();
    expect(decodeFilename(null).matched).toBe(false);
    expect(decodeFilename(undefined).matched).toBe(false);
  });

  it("is case-insensitive for known codes", () => {
    const d = decodeFilename("XNAS-ITCH-20230914.MBO.parquet");
    expect(d.venue.name).toBe("NASDAQ");
    expect(d.dataset.name).toBe("Market-by-Order");
  });
});

describe("dictionaries are internally consistent", () => {
  it("has lowercase keys and required fields", () => {
    for (const [k, v] of Object.entries(VENUES)) {
      expect(k).toBe(k.toLowerCase());
      expect(typeof v.name).toBe("string");
      expect(typeof v.detail).toBe("string");
    }
    for (const [k, v] of Object.entries(PROTOCOLS)) {
      expect(k).toBe(k.toLowerCase());
      expect(typeof v.name).toBe("string");
    }
    for (const [k, v] of Object.entries(DATASETS)) {
      expect(k).toBe(k.toLowerCase());
      expect(typeof v.name).toBe("string");
    }
    for (const [, v] of Object.entries(COLUMN_GLOSSARY)) {
      expect(typeof v.role).toBe("string");
      expect(typeof v.meaning).toBe("string");
    }
  });
});
