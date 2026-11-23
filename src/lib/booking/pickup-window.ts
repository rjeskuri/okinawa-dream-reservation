// Which pickup times the shop accepts, in JST: inside opening hours, on the slot grid that starts at shop_open, not on a
// closed pickup or return date, between the lead time and the booking horizon, and for an hours package, back inside
// opening hours.
import { rentalEnd } from "../db/blocking.ts";
import { epochToJst, formatHHmm, JST_OFFSET_MS, jstToEpoch, parseHHmm } from "../time.ts";
import type { PackageLength, ShopConfig } from "../types.ts";

export type PickupWindowReason =
  "OUTSIDE_HOURS" | "OFF_SLOT" | "CLOSED_PICKUP" | "RETURN_OUTSIDE_HOURS" | "CLOSED_RETURN" | "TOO_SOON" | "TOO_FAR";

/**
 * When a pickup is too soon. `lead`, a guest's: before now plus min_lead_hours. `slot`, staff's for a booking paid at the
 * shop (owner, #149): once its slot has ended, so at 10:07 with 30-minute slots 10:00 can still be booked and 09:30 cannot.
 */
export type TooSoonRule = "lead" | "slot";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Anything else as a slot length has no grid: it could never advance a loop, and no start would sit on it. */
function isSlotLength(slotMinutes: number): boolean {
  return Number.isInteger(slotMinutes) && slotMinutes > 0;
}

/**
 * Whether a rental of `pkg` picked up at `clockMs` past JST midnight is back between shop_open and shop_close, both
 * included, on whichever date it returns (owner, 2026-11-15). A day package returns at closing, so it always is.
 */
function returnsInHours(clockMs: number, pkg: PackageLength, openMs: number, closeMs: number): boolean {
  if (pkg.hours === null) return true;
  const back = (clockMs + pkg.hours * HOUR_MS) % DAY_MS;
  return back >= openMs && back <= closeMs;
}

/**
 * The pickup times of a day as HH:mm, from shop_open to the latest one that leaves a whole slot before shop_close. With an
 * hours package, only those it returns inside shop hours from, as pickupWindowError rules.
 */
export function pickupSlots(config: ShopConfig, pkg?: PackageLength): string[] {
  const { slotMinutes } = config;
  if (!isSlotLength(slotMinutes)) return [];
  const slots: string[] = [];
  const [open, close] = [parseHHmm(config.shopOpen), parseHHmm(config.shopClose)];
  for (let minute = open; minute <= close - slotMinutes; minute += slotMinutes) {
    const fits = pkg === undefined || returnsInHours(minute * MINUTE_MS, pkg, open * MINUTE_MS, close * MINUTE_MS);
    if (fits) slots.push(formatHHmm(minute));
  }
  return slots;
}

/** The instant of a pickup from a form or a query. NaN when it is no real date and time, which pickupWindowError refuses. */
export function pickupInstant(date: string, time: string): number {
  try {
    return jstToEpoch(date, time);
  } catch {
    return Number.NaN;
  }
}

/**
 * Why `startAt` cannot start a rental of `pkg`, or null when it can. A start that breaks several rules gets the first of:
 * not an instant (OFF_SLOT), TOO_SOON, TOO_FAR, OFF_SLOT, OUTSIDE_HOURS, CLOSED_PICKUP, RETURN_OUTSIDE_HOURS, CLOSED_RETURN.
 *
 * The clock comes first because it is plain arithmetic on any number, and what passes it is close enough to `now` for
 * the calendar helpers, which throw on a start like 1e15. The grid reads the whole instant, since a wall clock to the
 * minute hides stray seconds. A bad slot length refuses every start, as pickupSlots lists none. `tooSoon` picks the
 * TOO_SOON rule; every other rule is the same for both.
 */
export function pickupWindowError(
  config: ShopConfig,
  closedDates: string[],
  startAt: number,
  pkg: PackageLength,
  now: number,
  tooSoon: TooSoonRule = "lead",
): PickupWindowReason | null {
  // Number.isFinite because a caller's JSON can put anything here, and a numeric string would pass the comparisons.
  if (!Number.isFinite(startAt)) return "OFF_SLOT";

  // Written so that a NaN `now` comes out refused rather than accepted.
  const inTime =
    tooSoon === "slot"
      ? startAt + config.slotMinutes * MINUTE_MS > now
      : startAt >= now + config.minLeadHours * HOUR_MS;
  if (!inTime) return "TOO_SOON";
  if (!(startAt <= now + config.maxDaysAhead * DAY_MS)) return "TOO_FAR";

  if (!isSlotLength(config.slotMinutes)) return "OFF_SLOT";
  const slotMs = config.slotMinutes * MINUTE_MS;
  const openMs = parseHHmm(config.shopOpen) * MINUTE_MS;
  const closeMs = parseHHmm(config.shopClose) * MINUTE_MS;
  const sinceOpen = (startAt + JST_OFFSET_MS) % DAY_MS - openMs;
  if (sinceOpen % slotMs !== 0) return "OFF_SLOT";
  if (sinceOpen < 0 || sinceOpen > closeMs - slotMs - openMs) return "OUTSIDE_HOURS";

  if (closedDates.includes(epochToJst(startAt).date)) return "CLOSED_PICKUP";
  if (!returnsInHours(sinceOpen + openMs, pkg, openMs, closeMs)) return "RETURN_OUTSIDE_HOURS";
  if (closedDates.includes(epochToJst(rentalEnd(startAt, pkg, config)).date)) return "CLOSED_RETURN";
  return null;
}
