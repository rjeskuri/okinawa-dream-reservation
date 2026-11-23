// The bookings the sheet's Dashboard lets staff act on: CONFIRMED, not a block and not yet ended, found by ref, guest
// name or JST pickup date, earliest pickup first. The text is matched here rather than in SQL, because SQLite's LOWER
// folds ASCII alone and nothing there knows NFKC, so full-width letters and half-width katakana would slip past it. D1
// is read in pages in pickup order until enough bookings match, so no statement reads more than a page. Nothing here
// reads `env` or writes anything.
import { addDaysToDate, jstToEpoch } from "../time.ts";
import { nameIn } from "./cancel.ts";

export type StaffBookingSummary = {
  id: string;
  ref: string;
  status: string;
  source: string;
  modelId: string;
  modelNameJa: string;
  packageId: string | null;
  packageNameJa: string | null;
  plate: string;
  startAt: number;
  endAt: number;
  /** Family name first, then given name, one space apart; either may be missing. */
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  priceJpy: number | null;
  depositJpy: number | null;
  paidJpy: number;
};

/** `text` is a ref or part of a guest name; `date` a JST pickup date in YYYY-MM-DD. */
export type StaffQuery = { text?: string; date?: string };

export type StaffQueryCheck = { ok: true; query: StaffQuery } | { ok: false; reason: "BAD_SHAPE" | "BAD_QUERY" };

/** The most bookings one search answers. */
const MAX_RESULTS = 20;

/** The text staff can type, in characters as sent. */
const MAX_TEXT_CHARS = 100;

/** How many bookings one statement reads while a text filter looks for matches. */
const PAGE_SIZE = 200;

type Row = {
  id: string;
  ref: string;
  status: string;
  source: string;
  model_id: string;
  model_texts: string | null;
  package_id: string | null;
  package_texts: string | null;
  vehicle_plate: string;
  start_at: number;
  end_at: number;
  guest_family_name: string | null;
  guest_given_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  price_jpy: number | null;
  deposit_jpy: number | null;
  paid_jpy: number;
};

/**
 * ?1 now, ?2 and ?3 the pickup window (start inclusive, end exclusive), ?4 and ?5 the start_at and id the page follows,
 * ?6 the page size. The window and the cursor are open when their parameters are NULL.
 */
const PAGE_SQL = `SELECT b.id, b.ref, b.status, b.source, b.model_id, m.texts AS model_texts, b.package_id,
    p.texts AS package_texts, b.vehicle_plate, b.start_at, b.end_at, b.guest_family_name, b.guest_given_name,
    b.guest_email, b.guest_phone, b.price_jpy, b.deposit_jpy, b.paid_jpy
  FROM bookings b
  LEFT JOIN models m ON m.id = b.model_id
  LEFT JOIN packages p ON p.id = b.package_id
  WHERE b.status = 'CONFIRMED' AND b.source <> 'block' AND b.end_at > ?1
    AND (?2 IS NULL OR b.start_at >= ?2) AND (?3 IS NULL OR b.start_at < ?3)
    AND (?4 IS NULL OR b.start_at > ?4 OR (b.start_at = ?4 AND b.id > ?5))
  ORDER BY b.start_at, b.id
  LIMIT ?6`;

/** NFKC, lower case, and each run of white space one plain space, trimmed. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  try {
    jstToEpoch(date);
    return true;
  } catch {
    return false;
  }
}

/**
 * The search a signed payload asks for. A text or date that is missing, null or blank leaves that filter off. BAD_SHAPE
 * is a payload the panel never sends: not an object, a `requestedBy` that is not a string, or a text or date that is
 * not a string. BAD_QUERY is one staff can type: a text over 100 characters or a date that is not a real YYYY-MM-DD.
 */
export function parseStaffQuery(payload: unknown): StaffQueryCheck {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "BAD_SHAPE" };
  }
  const { requestedBy, text, date } = payload as Record<string, unknown>;
  if (typeof requestedBy !== "string") return { ok: false, reason: "BAD_SHAPE" };
  if (!(text === undefined || text === null || typeof text === "string")) return { ok: false, reason: "BAD_SHAPE" };
  if (!(date === undefined || date === null || typeof date === "string")) return { ok: false, reason: "BAD_SHAPE" };

  const query: StaffQuery = {};
  if (typeof text === "string") {
    if ([...text].length > MAX_TEXT_CHARS) return { ok: false, reason: "BAD_QUERY" };
    if (fold(text) !== "") query.text = text;
  }
  if (typeof date === "string" && date.trim() !== "") {
    if (!isValidDate(date)) return { ok: false, reason: "BAD_QUERY" };
    query.date = date;
  }
  return { ok: true, query };
}

/** Whether `needle`, folded, is the booking's ref or is inside its guest's name in either order. */
function matches(row: Row, needle: string): boolean {
  if (fold(row.ref) === needle) return true;
  const family = row.guest_family_name === null ? null : fold(row.guest_family_name);
  const given = row.guest_given_name === null ? null : fold(row.guest_given_name);
  const names = [family, given];
  if (family !== null && given !== null) names.push(`${family} ${given}`, `${given} ${family}`);
  return names.some((name) => name !== null && name.includes(needle));
}

function summary(row: Row): StaffBookingSummary {
  return {
    id: row.id,
    ref: row.ref,
    status: row.status,
    source: row.source,
    modelId: row.model_id,
    modelNameJa: nameIn(row.model_texts, "ja"),
    packageId: row.package_id,
    packageNameJa: row.package_texts === null ? null : nameIn(row.package_texts, "ja"),
    plate: row.vehicle_plate,
    startAt: row.start_at,
    endAt: row.end_at,
    guestName: [row.guest_family_name, row.guest_given_name].filter((name) => name !== null && name !== "").join(" "),
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    priceJpy: row.price_jpy,
    depositJpy: row.deposit_jpy,
    paidJpy: row.paid_jpy,
  };
}

/**
 * The first 20 bookings staff can act on that match `query`, earliest pickup first. Both filters must match when both
 * are given, and neither lists the next 20. `query.date` must be a real YYYY-MM-DD: parseStaffQuery checks it.
 */
export async function findBookingsForStaff(
  db: D1Database,
  query: StaffQuery,
  now: number,
): Promise<StaffBookingSummary[]> {
  const needle = query.text === undefined ? "" : fold(query.text);
  const from = query.date === undefined ? null : jstToEpoch(query.date);
  const until = query.date === undefined ? null : jstToEpoch(addDaysToDate(query.date, 1));
  const pageSize = needle === "" ? MAX_RESULTS : PAGE_SIZE;

  const found: StaffBookingSummary[] = [];
  let after: { startAt: number; id: string } | null = null;
  for (;;) {
    const page: D1Result<Row> = await db
      .prepare(PAGE_SQL)
      .bind(now, from, until, after?.startAt ?? null, after?.id ?? null, pageSize)
      .all<Row>();
    for (const row of page.results) {
      if (needle !== "" && !matches(row, needle)) continue;
      found.push(summary(row));
      if (found.length === MAX_RESULTS) return found;
    }
    const last: Row | undefined = page.results.at(-1);
    if (page.results.length < pageSize || last === undefined) return found;
    after = { startAt: last.start_at, id: last.id };
  }
}
