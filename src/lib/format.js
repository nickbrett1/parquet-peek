// Small client-safe formatting helpers (no server imports).

const countFmt = new Intl.NumberFormat("en-US");

/** 1234567 → "1,234,567" */
export function formatCount(value) {
  return countFmt.format(value ?? 0);
}

/** 5915000000 → "5.9 GB" */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * DuckDB footer stats come back as printable strings (e.g.
 * "2024-08-05 13:30:00.123456789" or "123.45"). Keep them raw but compact
 * for display; null → "—".
 */
export function formatStat(value) {
  if (value === null || value === undefined || value === "") return "—";
  const s = String(value);
  return s.length > 24 ? `${s.slice(0, 21)}…` : s;
}
