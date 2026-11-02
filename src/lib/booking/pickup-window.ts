// Which pickup times the shop accepts, in JST: inside opening hours, on the slot grid that starts at shop_open, not on a
// closed pickup or return date, and between the lead time and the booking horizon.
import { rentalEnd } from "../db/blocking.ts";
import { epochToJst, formatHHmm, JST_OFFSET_MS, parseHHmm } from "../time.ts";
import type { ShopConfig } from "../types.ts";

export type PickupWindowReason = "OUTSIDE_HOURS" | "OFF_SLOT" | "CLOSED_PICKUP" | "CLOSED_RETURN" | "TOO_SOON" | "TOO_FAR";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Anything else as a slot length has no grid: it could never advance a loop, and no start would sit on it. */
function isSlotLength(slotMinutes: number): boolean {
  return Number.isInteger(slotMinutes) && slotMinutes > 0;
}

/** The pickup times of a day as HH:mm, from shop_open to the latest one that leaves a whole slot before shop_close. */
export function pickupSlots(config: ShopConfig): string[] {
  const { slotMinutes } = config;
  if (!isSlotLength(slotMinutes)) return [];
  const slots: string[] = [];
  const last = parseHHmm(config.shopClose) - slotMinutes;
  for (let minute = parseHHmm(config.shopOpen); minute <= last; minute += slotMinutes) slots.push(formatHHmm(minute));
  return slots;
}

/**
 * Why `startAt` cannot start a rental of `days` days, or null when it can. A start that breaks several rules gets the
 * first of: not an instant (OFF_SLOT), TOO_SOON, TOO_FAR, OFF_SLOT, OUTSIDE_HOURS, CLOSED_PICKUP, CLOSED_RETURN.
 *
 * The clock comes first because it is plain arithmetic on any number, and what passes it is close enough to `now` for
 * the calendar helpers, which throw on a start like 1e15. The grid reads the whole instant, since a wall clock to the
 * minute hides stray seconds. A bad slot length refuses every start, as pickupSlots lists none.
 */
export function pickupWindowError(
  config: ShopConfig,
  closedDates: string[],
  startAt: number,
  days: number,
  now: number,
): PickupWindowReason | null {
  // Number.isFinite because a caller's JSON can put anything here, and a numeric string would pass the comparisons.
  if (!Number.isFinite(startAt)) return "OFF_SLOT";

  // Written so that a NaN `now` comes out refused rather than accepted.
  if (!(startAt >= now + config.minLeadHours * HOUR_MS)) return "TOO_SOON";
  if (!(startAt <= now + config.maxDaysAhead * DAY_MS)) return "TOO_FAR";

  if (!isSlotLength(config.slotMinutes)) return "OFF_SLOT";
  const slotMs = config.slotMinutes * MINUTE_MS;
  const openMs = parseHHmm(config.shopOpen) * MINUTE_MS;
  const closeMs = parseHHmm(config.shopClose) * MINUTE_MS;
  const sinceOpen = (startAt + JST_OFFSET_MS) % DAY_MS - openMs;
  if (sinceOpen % slotMs !== 0) return "OFF_SLOT";
  if (sinceOpen < 0 || sinceOpen > closeMs - slotMs - openMs) return "OUTSIDE_HOURS";

  if (closedDates.includes(epochToJst(startAt).date)) return "CLOSED_PICKUP";
  if (closedDates.includes(epochToJst(rentalEnd(startAt, { days }, config)).date)) return "CLOSED_RETURN";
  return null;
}
