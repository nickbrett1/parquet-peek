// highlights.js — turns sampled aggregate stats into plain-English bullets
// ("what's interesting") and templated suggestions for the desktop notebook.
//
// Pure and client-safe (imports only ./format.js). The DuckDB work happens in
// parquet-store.js; this module only formats the results, so it is trivially
// testable and keeps the UI dumb.

import { formatCompact, formatCount, formatPct } from "./format.js";

function pctOf(count, n) {
  return n > 0 ? (count / n) * 100 : 0;
}

/** Render a price for a sentence; numbers get ≤4 decimals, strings pass through. */
function fmtPrice(v) {
  if (v === null || v === undefined || v === "") return null;
  const num = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(num)) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(
      num,
    );
  }
  return String(v);
}

/** Coverage — what the file is, from the decoded filename or the ts range. */
function coverageBullet(h) {
  if (h.decoded?.matched && h.decoded?.summary) return h.decoded.summary;
  if (h.minTs && h.maxTs) return `Covers ${h.minTs} → ${h.maxTs}`;
  return null;
}

/** Volume — sum of the size column over the scanned rows. */
function volumeBullet(h) {
  if (!h.sizeCol || h.sumSize === null || h.sumSize === undefined) return null;
  return `Σ ${h.sizeCol} ≈ ${formatCompact(h.sumSize)} shares${h.sampled ? " (in sampled events)" : ""}`;
}

/** Symbols — distinct count plus the most active. */
function symbolBullet(h, n) {
  if (h.topSymbols?.length) {
    const top = h.topSymbols
      .slice(0, 3)
      .map((t) => `${t.value ?? "∅"} ${formatPct(pctOf(t.count, n))}`)
      .join(", ");
    const countTxt =
      h.nSymbols === 1 ? "1 symbol" : `≈${formatCount(h.nSymbols)} symbols`;
    const lead =
      h.nSymbols !== null && h.nSymbols !== undefined && h.nSymbols > 0
        ? `${countTxt}; most active: ${top}`
        : `Most active: ${top}`;
    return lead;
  }
  if (
    h.symCol &&
    h.nSymbols !== null &&
    h.nSymbols !== undefined &&
    h.nSymbols > 0
  ) {
    return `≈${formatCount(h.nSymbols)} distinct ${h.symCol}`;
  }
  return null;
}

/** Price shape — typical price, 90% band, full range. */
function priceBullet(h) {
  if (!h.pxCol || h.pxStats?.p50 === null || h.pxStats?.p50 === undefined)
    return null;
  const p = h.pxStats;
  const parts = [`typical ${h.pxCol} ≈ $${fmtPrice(p.p50)}`];
  if (
    p.p05 !== null &&
    p.p05 !== undefined &&
    p.p95 !== null &&
    p.p95 !== undefined
  ) {
    parts.push(`90% of events $${fmtPrice(p.p05)}–$${fmtPrice(p.p95)}`);
  }
  if (
    p.min !== null &&
    p.min !== undefined &&
    p.max !== null &&
    p.max !== undefined
  ) {
    parts.push(`range $${fmtPrice(p.min)}–$${fmtPrice(p.max)}`);
  }
  return parts.join(" · ");
}

/** Busiest hours (UTC). */
function hourBullet(h, n) {
  if (!h.hours?.length) return null;
  const top3 = h.hours
    .map(
      (x) =>
        `${String(x.hour).padStart(2, "0")}:00 UTC ${formatPct(pctOf(x.count, n))}`,
    )
    .join(", ");
  return `Busiest hours: ${top3}`;
}

/** Categorical mixes (side, action, rtype, …). */
function categoryBullets(h, n) {
  const out = [];
  for (const ct of h.categoryTops || []) {
    if (!ct.values?.length) continue;
    const mix = ct.values
      .slice(0, 4)
      .map((v) => `${v.value ?? "∅"} ${formatPct(pctOf(v.count, n))}`)
      .join(" · ");
    out.push(`${ct.column}: ${mix}`);
  }
  return out;
}

/** Notebook questions — templated, only when the evidence exists. */
function buildQuestions(h, n) {
  const questions = [];
  if (
    h.hours?.length &&
    h.hours[0].hour !== undefined &&
    h.hours[0].count > 0
  ) {
    const hh = String(h.hours[0].hour).padStart(2, "0");
    questions.push(
      `Why does activity peak at ${hh}:00 UTC? Opening/closing auction, a product event, or just the regular session?`,
    );
  }
  if (h.topSymbols?.length && (h.nSymbols ?? 0) > 1) {
    const t0 = h.topSymbols[0];
    questions.push(
      `${t0.value ?? "The top symbol"} is ${formatPct(pctOf(t0.count, n))} of sampled events — is that concentration expected, and how does it change intraday?`,
    );
  }
  const action = (h.categoryTops || []).find(
    (c) => c.column.toLowerCase() === "action",
  );
  const del = action?.values?.find(
    (v) => String(v.value).toUpperCase() === "D",
  );
  if (del && pctOf(del.count, n) >= 5) {
    questions.push(
      `${formatPct(pctOf(del.count, n))} of events are deletes/cancels — high order churn? Compare against another day to see if that's normal.`,
    );
  }
  const lo = Number(h.pxStats?.min);
  const hi = Number(h.pxStats?.max);
  const mid = Number(h.pxStats?.p50);
  if (
    Number.isFinite(lo) &&
    Number.isFinite(hi) &&
    Number.isFinite(mid) &&
    mid > 0 &&
    (hi - lo) / mid > 10
  ) {
    questions.push(
      `Price spans $${fmtPrice(h.pxStats.min)} to $${fmtPrice(h.pxStats.max)} (median $${fmtPrice(mid)}) — sanity-check the extremes for outlier ticks.`,
    );
  }
  if (questions.length === 0) {
    questions.push(
      "How does activity vary across the busiest hour vs. the rest of the day?",
    );
  }
  return questions;
}

/**
 * Build the TL;DR bullets and notebook questions for one file.
 *
 * Input shape (all fields optional, built by parquet-store.getHighlights):
 * {
 *   decoded: { summary, matched, ... },                  // from decodeFilename
 *   rowCount, sampled, sampleN,
 *   minTs, maxTs,
 *   symCol, nSymbols, topSymbols: [{value, count}],
 *   pxCol, pxStats: {min, max, p05, p50, p95},
 *   sizeCol, sumSize,
 *   hours: [{hour, count}],
 *   categoryTops: [{column, values: [{value, count}]}],
 * }
 */
export function buildHighlights(h) {
  const n = h.sampleN || 0;
  const bullets = [
    coverageBullet(h),
    volumeBullet(h),
    symbolBullet(h, n),
    priceBullet(h),
    hourBullet(h, n),
    ...categoryBullets(h, n),
  ].filter(Boolean);
  if (bullets.length === 0) {
    if (n > 0) {
      const suffix = h.sampled ? " (sample)" : "";
      bullets.push(`${formatCount(n)} events scanned${suffix}`);
    } else {
      bullets.push("File has 0 rows.");
    }
  }
  return { bullets, questions: buildQuestions(h, n) };
}
