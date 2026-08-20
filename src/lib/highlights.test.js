import { describe, expect, it } from "vitest";
import { buildHighlights } from "./highlights.js";

function fullInput(overrides = {}) {
  return {
    decoded: {
      summary:
        "NASDAQ · ITCH · 2023-09-14 · Market-by-Order — one message per order add / modify / delete on the order book",
      matched: true,
      date: "2023-09-14",
      venue: { name: "NASDAQ" },
      protocol: { name: "ITCH" },
      dataset: { name: "Market-by-Order" },
    },
    rowCount: 361_000_000,
    sampled: true,
    sampleN: 1_000_000,
    minTs: "2023-09-14 09:30:00",
    maxTs: "2023-09-14 16:00:00",
    symCol: "symbol",
    nSymbols: 7400,
    topSymbols: [
      { value: "SPY", count: 90_000 },
      { value: "AAPL", count: 60_000 },
      { value: "QQQ", count: 50_000 },
    ],
    pxCol: "price",
    pxStats: { min: 0.01, max: 2300, p05: 12.5, p50: 150.0, p95: 890.0 },
    sizeCol: "size",
    sumSize: 1_240_000_000,
    hours: [
      { hour: 14, count: 300_000 },
      { hour: 15, count: 250_000 },
      { hour: 13, count: 200_000 },
    ],
    categoryTops: [
      {
        column: "action",
        values: [
          { value: "A", count: 610_000 },
          { value: "M", count: 220_000 },
          { value: "D", count: 170_000 },
        ],
      },
      {
        column: "side",
        values: [
          { value: "B", count: 520_000 },
          { value: "S", count: 480_000 },
        ],
      },
    ],
    ...overrides,
  };
}

describe("buildHighlights bullets", () => {
  it("produces a coverage, volume, symbol, price, hour and category bullet", () => {
    const { bullets } = buildHighlights(fullInput());
    const joined = bullets.join("\n");
    expect(bullets[0]).toContain("NASDAQ");
    expect(joined).toContain("Σ size ≈ 1.2B shares (in sampled events)");
    expect(joined).toContain("≈7,400 symbols; most active: SPY 9%");
    expect(joined).toContain("typical price ≈ $150");
    expect(joined).toContain("90% of events $12.5–$890");
    expect(joined).toContain("Busiest hours: 14:00 UTC 30%");
    expect(joined).toContain("action: A 61% · M 22% · D 17%");
    expect(joined).toContain("side: B 52% · S 48%");
  });

  it("marks an unscanned small file (sampled=false) without the sample caveat", () => {
    const { bullets } = buildHighlights(fullInput({ sampled: false }));
    expect(bullets.join("\n")).toContain("Σ size ≈ 1.2B shares");
    expect(bullets.join("\n")).not.toContain("in sampled events");
  });

  it("falls back to a scan-count bullet when nothing else matches", () => {
    const { bullets } = buildHighlights({
      sampleN: 500,
      sampled: true,
      rowCount: 1000,
    });
    expect(bullets[0]).toBe("500 events scanned (sample)");
  });

  it("handles a 0-row file", () => {
    const { bullets } = buildHighlights({
      sampleN: 0,
      sampled: false,
      rowCount: 0,
    });
    expect(bullets[0]).toBe("File has 0 rows.");
  });

  it("drops symbol and price bullets when those columns are absent", () => {
    const input = fullInput({
      symCol: null,
      nSymbols: null,
      topSymbols: [],
      pxCol: null,
      pxStats: null,
    });
    const joined = buildHighlights(input).bullets.join("\n");
    expect(joined).not.toContain("symbols");
    expect(joined).not.toContain("typical price");
  });
});

describe("buildHighlights questions", () => {
  it("asks about the peak hour and the dominant symbol", () => {
    const { questions } = buildHighlights(fullInput());
    expect(questions.some((q) => q.includes("14:00 UTC"))).toBe(true);
    expect(questions.some((q) => q.includes("SPY is 9%"))).toBe(true);
  });

  it("asks about delete churn when deletes are a meaningful share", () => {
    const { questions } = buildHighlights(fullInput());
    expect(
      questions.some((q) => q.includes("17% of events are deletes/cancels")),
    ).toBe(true);
  });

  it("does not ask about delete churn when deletes are tiny or absent", () => {
    const noDeletes = buildHighlights(
      fullInput({
        categoryTops: [
          { column: "action", values: [{ value: "A", count: 999_000 }] },
        ],
      }),
    );
    expect(noDeletes.questions.some((q) => q.includes("deletes/cancels"))).toBe(
      false,
    );
  });

  it("flags extreme price ranges", () => {
    const { questions } = buildHighlights(
      fullInput({
        pxStats: { min: 0.01, max: 2300, p05: 12.5, p50: 150, p95: 890 },
      }),
    );
    expect(questions.some((q) => q.includes("outlier ticks"))).toBe(true);
  });

  it("falls back to a generic question", () => {
    const { questions } = buildHighlights({
      sampleN: 0,
      sampled: false,
      rowCount: 0,
    });
    expect(questions.length).toBe(1);
    expect(questions[0]).toContain("busiest hour");
  });
});
