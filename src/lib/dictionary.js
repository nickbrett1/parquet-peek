// dictionary.js — static knowledge base for market-data parquet files
// (Databento-style exports, e.g. `xnas-itch-20230914.mbo.parquet`).
//
// Pure and client-safe (no node imports): used server-side to enrich profiles
// and highlights, and client-side to decode filenames on the file cards.
//
// Everything here is best-effort reference knowledge — the stats still come
// from the data; this just explains what each piece usually means.

/** Exchange / venue codes seen in filenames. */
export const VENUES = {
  xnas: { name: "NASDAQ", detail: "Nasdaq stock exchange" },
  xnys: { name: "NYSE", detail: "New York Stock Exchange" },
  xbxo: { name: "Cboe BZX", detail: "Cboe BZX exchange" },
  bats: { name: "Cboe BATS", detail: "Cboe BATS exchange" },
  xbxr: { name: "Cboe BYX", detail: "Cboe BYX exchange" },
  xedg: { name: "Cboe EDGX", detail: "Cboe EDGX exchange" },
  xedga: { name: "Cboe EDGA", detail: "Cboe EDGA exchange" },
  xcbo: { name: "Cboe", detail: "Cboe Options Exchange" },
  glbx: { name: "CME Globex", detail: "CME's electronic trading platform" },
  amex: { name: "NYSE American", detail: "NYSE American (small-cap) exchange" },
  arca: { name: "NYSE Arca", detail: "NYSE Arca exchange (ETPs)" },
  xphi: { name: "Nasdaq PSX", detail: "Nasdaq PSX exchange" },
  opra: {
    name: "OPRA",
    detail: "Options Price Reporting Authority (options tape)",
  },
  cta: {
    name: "CTA",
    detail: "Consolidated Tape Association (SIP trades tape)",
  },
  utp: {
    name: "UTP",
    detail: "Unlisted Trading Privileges (SIP tape for Nasdaq-listed)",
  },
};

/** Feed protocols seen in filenames. */
export const PROTOCOLS = {
  itch: { name: "ITCH", detail: "Nasdaq's order-level market data feed" },
  mdp3: { name: "MDP 3.0", detail: "CME's Market Data Platform feed" },
  opra: { name: "OPRA", detail: "Options quote/trade feed" },
  cta: { name: "CTA", detail: "Consolidated SIP trades feed" },
  utp: { name: "UTP", detail: "Consolidated SIP quotes/trades feed" },
};

/** Dataset / record-type codes seen in filenames. */
export const DATASETS = {
  mbo: {
    name: "Market-by-Order",
    detail: "one message per order add / modify / delete on the order book",
  },
  "mbp-1": {
    name: "Market-by-Price (L1)",
    detail: "top-of-book best bid/offer updates",
  },
  "mbp-10": {
    name: "Market-by-Price (L10)",
    detail: "top-10 price levels of the order book",
  },
  trades: { name: "Trades", detail: "every executed trade (prints)" },
  "trades-vwap": {
    name: "Trades + VWAP",
    detail: "executed trades with session volume-weighted average price",
  },
  "ohlcv-1s": {
    name: "OHLCV 1s",
    detail: "open / high / low / close / volume bars, 1-second",
  },
  "ohlcv-1m": {
    name: "OHLCV 1m",
    detail: "open / high / low / close / volume bars, 1-minute",
  },
  "ohlcv-1h": {
    name: "OHLCV 1h",
    detail: "open / high / low / close / volume bars, 1-hour",
  },
  "ohlcv-1d": {
    name: "OHLCV 1d",
    detail: "open / high / low / close / volume bars, 1-day",
  },
  definition: {
    name: "Instrument definitions",
    detail:
      "reference data: symbol, instrument class, price scale per instrument",
  },
  imbalance: { name: "Imbalance", detail: "auction order-imbalance messages" },
};

/**
 * Column meanings for the standard Databento schema (and a few close
 * relatives). `role` drives how the UI renders the column's stats; `meaning`
 * is the plain-English explanation; `unit` is shown when it helps.
 */
export const COLUMN_GLOSSARY = {
  ts_event: {
    role: "timestamp",
    meaning: "Event time — when the market event actually happened (UTC).",
    unit: "ns since epoch",
  },
  ts_recv: {
    role: "timestamp",
    meaning: "Receive time — when the feed received the message (UTC).",
    unit: "ns since epoch",
  },
  ts_in_delta: {
    role: "numeric",
    meaning: "Latency — how long after the event the message was received.",
    unit: "ns",
  },
  ts_out_delta: {
    role: "numeric",
    meaning:
      "Time between the message being received and it being sent onward.",
    unit: "ns",
  },
  rtype: {
    role: "category",
    meaning:
      "Record type — what kind of record this is (O=orders, T=trades, M=market-by-price, D=definitions, …).",
  },
  publisher_id: {
    role: "id",
    meaning: "Publisher — which venue/feed published the message.",
  },
  instrument_id: {
    role: "id",
    meaning:
      "Instrument — numeric ID of the security (join to a definitions file for the symbol).",
  },
  action: {
    role: "category",
    meaning:
      "Order action — A=add, M=modify, D=delete, C=cancel, F=fill, R=reduce.",
  },
  side: {
    role: "category",
    meaning: "Order side — B=buy (bid), S=sell (ask).",
  },
  price: { role: "price", meaning: "Price per share, in USD." },
  size: {
    role: "size",
    meaning: "Quantity — how many shares this event involves.",
  },
  sequence: {
    role: "id",
    meaning: "Sequence number — message order within the venue's feed.",
  },
  symbol: { role: "symbol", meaning: "Ticker symbol (e.g. AAPL, SPY)." },
  flags: {
    role: "category",
    meaning:
      "Message flags — bitfield describing message properties (odd lot, cross, …).",
  },
  order_id: {
    role: "id",
    meaning: "Order ID — the venue's unique ID for the order.",
  },
  channel_id: {
    role: "id",
    meaning: "Channel — internal feed channel the message arrived on.",
  },
  instrument_class: {
    role: "category",
    meaning:
      "Instrument class — what kind of instrument (stock, option, future, …).",
  },
  strike_price: {
    role: "price",
    meaning: "Strike price of an option, in USD.",
  },
  expiration: {
    role: "timestamp",
    meaning: "Expiration date of an option or future.",
  },
};

/** Column roles used across the app (drive rendering + which stats matter). */
export const ROLES = [
  "timestamp",
  "price",
  "size",
  "id",
  "category",
  "symbol",
  "numeric",
  "text",
  "other",
];

/** True for numeric duckdb types (safe to aggregate with quantiles/sums). */
export function isNumericType(type) {
  return /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)\b/i.test(
    String(type ?? ""),
  );
}

/** True for string-ish duckdb types (candidates for categorical top-N). */
export function isVarcharType(type) {
  return /^(VARCHAR|STRING|TEXT|CHAR|ENUM|UUID)\b/i.test(String(type ?? ""));
}

/**
 * Best-effort description of a column: glossary first, then name heuristics,
 * then type-based fallback. Always returns a role; `meaning` is null when we
 * have no idea what the column is.
 */
export function describeColumn(name, type) {
  const key = String(name ?? "").toLowerCase();
  const known = COLUMN_GLOSSARY[key];
  if (known)
    return {
      role: known.role,
      meaning: known.meaning,
      unit: known.unit ?? null,
      known: true,
    };

  if (/(^|_)ts(_|$)|time|date/.test(key)) {
    return {
      role: "timestamp",
      meaning: "Time field — when something happened.",
      unit: null,
      known: false,
    };
  }
  if (/price|strike|^px$|_px/.test(key)) {
    return {
      role: "price",
      meaning: "Price per share, in USD.",
      unit: "USD",
      known: false,
    };
  }
  if (/size|qty|quantity|volume|shares/.test(key)) {
    return {
      role: "size",
      meaning: "Quantity — number of shares.",
      unit: "shares",
      known: false,
    };
  }
  if (/_id$|^id$|sequence|^seq$|uuid|order_id/.test(key)) {
    return {
      role: "id",
      meaning: "Identifier — a key that maps to a value in another table.",
      unit: null,
      known: false,
    };
  }
  if (/symbol|ticker/.test(key)) {
    return {
      role: "symbol",
      meaning: "Ticker symbol (e.g. AAPL, SPY).",
      unit: null,
      known: false,
    };
  }
  if (isVarcharType(type)) {
    return {
      role: "text",
      meaning: "Text / categorical value.",
      unit: null,
      known: false,
    };
  }
  if (isNumericType(type)) {
    return {
      role: "numeric",
      meaning: "Numeric value.",
      unit: null,
      known: false,
    };
  }
  return { role: "other", meaning: null, unit: null, known: false };
}

/**
 * Decode a Databento-style filename (`xnas-itch-20230914.mbo.parquet`) into
 * structured, plain-English parts. Graceful when nothing matches: unknown
 * tokens are collected in `unrecognized` and `matched` stays false.
 */
export function decodeFilename(name) {
  const out = {
    summary: null,
    matched: false,
    date: null,
    venue: null,
    protocol: null,
    dataset: null,
    unrecognized: [],
  };
  if (typeof name !== "string" || name.trim() === "") return out;

  const base = name.replace(/\.parquet$/i, "");
  const segs = base.split(".").filter(Boolean);
  let datasetTok = null;
  if (segs.length > 1) datasetTok = segs.pop();
  const tokens = segs.join("-").split("-").filter(Boolean);

  const dateTok = tokens.find((t) => /^\d{8}$/.test(t));
  if (dateTok) {
    out.date = `${dateTok.slice(0, 4)}-${dateTok.slice(4, 6)}-${dateTok.slice(6, 8)}`;
  }

  const venueTok = tokens[0];
  const protocolTok = tokens[1];
  if (venueTok && VENUES[venueTok.toLowerCase()]) {
    out.venue = { code: venueTok, ...VENUES[venueTok.toLowerCase()] };
  }
  if (protocolTok && PROTOCOLS[protocolTok.toLowerCase()]) {
    out.protocol = {
      code: protocolTok,
      ...PROTOCOLS[protocolTok.toLowerCase()],
    };
  }
  if (datasetTok && DATASETS[datasetTok.toLowerCase()]) {
    out.dataset = { code: datasetTok, ...DATASETS[datasetTok.toLowerCase()] };
  }

  const known = new Set(
    [out.venue?.code, out.protocol?.code, dateTok, datasetTok].filter(Boolean),
  );
  for (const t of tokens) {
    if (!known.has(t)) out.unrecognized.push(t);
  }

  const bits = [];
  if (out.venue) bits.push(out.venue.name);
  else if (venueTok) bits.push(venueTok);
  if (out.protocol) bits.push(out.protocol.name);
  else if (protocolTok) bits.push(protocolTok);
  if (out.date) bits.push(out.date);
  if (out.dataset) bits.push(`${out.dataset.name} — ${out.dataset.detail}`);
  else if (datasetTok) bits.push(datasetTok);
  if (out.unrecognized.length > 0)
    bits.push(`unrecognized: ${out.unrecognized.join(", ")}`);
  out.summary = bits.join(" · ") || base;
  out.matched = Boolean(out.venue || out.protocol || out.dataset || out.date);
  return out;
}
