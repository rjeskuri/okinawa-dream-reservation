// A reservation staff take by phone or at the counter (#149), paid at the shop: no online payment, the deposit collected in
// person. It takes the least-used free bike as a web hold does, in one conditional INSERT, and is CONFIRMED from the start,
// holding its bike until it is cancelled. Its emails and its Bookings row go in the same batch as that INSERT, each only if
// the INSERT wrote this call's row, so a booking never stands without them and a call that booked nothing queues nothing.
import { type Guest, type GuestCode, validateGuest } from "../checkout.ts";
import { randomRef } from "../crypto.ts";
import { isLocale, type Locale } from "../locale.ts";
import type { OutboxItem } from "../outbox.ts";
import { bookedAhead } from "../pricing.ts";
import type { Booking } from "../types.ts";
import { type ConfirmationRow, confirmationItems } from "./confirm.ts";
import {
  assignFreeVehicleSql,
  type BookingRow,
  checkRental,
  getBooking,
  type HoldReason,
  isKey,
  lockedPriceSql,
  REF_ATTEMPTS,
  toBooking,
} from "./holds.ts";

export type StaffBookingInput = {
  id: string;
  modelId: string;
  packageId: string;
  startAt: number;
  locale: Locale;
  guest: Guest;
  /** Who on the staff asked. Not stored and not compared on a replay: it names who asked, not what was booked. */
  requestedBy: string;
};

export type StaffBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: HoldReason | "INVALID_GUEST"; fields?: GuestCode[] };

type StaffBookingContext = { siteUrl: string; cancelSecret: string; staffEmail: string };

/**
 * The staff booking, as HOLD_SQL is the hold: the bike, the price and the deposit are read inside the statement that writes
 * them, so neither a rival nor a publish between the checks and here can make it take a bike that is gone or a price that
 * has moved. ?10 is 1 when it is booked ahead of the pickup's JST date. A taken id or ref inserts nothing, as no free bike
 * does, and createStaffBooking tells the three apart.
 */
const STAFF_SQL = `WITH q(s, e, buf, now, model) AS (SELECT ?1, ?2, ?3, ?4, ?5)
  INSERT INTO bookings (id, ref, status, source, model_id, package_id, vehicle_plate, start_at, end_at, price_jpy,
    deposit_jpy, catalog_version, locale, guest_family_name, guest_given_name, guest_email, guest_phone, created_at,
    updated_at, confirmed_at)
  SELECT ?6, ?7, 'CONFIRMED', 'staff', m.id, p.package_id, v.plate, ?1, ?2,
    ${lockedPriceSql("?10")},
    t.deposit_jpy, c.version, ?8, ?11, ?12, ?13, ?14, ?4, ?4, ?4
  FROM vehicles v
  JOIN models m ON m.id = v.model_id
  JOIN prices p ON p.rate_class_id = m.rate_class_id AND p.package_id = ?9
  JOIN vehicle_types t ON t.id = m.type_id
  JOIN catalog_meta c ON c.id = 1
  WHERE m.active = 1 AND v.plate = (${assignFreeVehicleSql})
  ON CONFLICT DO NOTHING
  RETURNING *`;

/**
 * Queues one item only if STAFF_SQL, earlier in the same batch, wrote this call's row: the row has to carry this call's
 * ref, which a rival under the same id does not. STAFF_SQL picked the bike, the price and the deposit, so the payload takes
 * them from that row wherever it has those fields. Reads ?5 the booking and ?6 the ref.
 */
const QUEUE_SQL = `INSERT OR IGNORE INTO outbox (kind, dedupe_key, payload, status, next_attempt_at, created_at)
  SELECT ?1, ?2,
    json_replace(?3, '$.data.vehiclePlate', b.vehicle_plate, '$.data.priceJpy', b.price_jpy,
      '$.data.depositJpy', b.deposit_jpy),
    'pending', ?4, ?4
  FROM bookings b WHERE b.id = ?5 AND b.ref = ?6`;

/** The names of a model and a package, null where either is missing. */
const TEXTS_SQL =
  "SELECT (SELECT texts FROM models WHERE id = ?1) AS model_texts, (SELECT texts FROM packages WHERE id = ?2) AS package_texts";

type Texts = Pick<ConfirmationRow, "model_texts" | "package_texts">;

function refuse(reason: HoldReason): StaffBookingResult {
  return { ok: false, reason };
}

/**
 * What a staff booking queues: what markConfirmed queues for a payment of nothing, with the guest's confirmation saying the
 * deposit is paid at the shop. A guest who gave no email gets no confirmation. `row` comes before the bike, the price and
 * the deposit are known, so it carries none of them: QUEUE_SQL writes them in.
 */
async function staffItems(db: D1Database, row: ConfirmationRow, ctx: StaffBookingContext): Promise<OutboxItem[]> {
  const items = await confirmationItems(db, row, 0, ctx);
  return items.flatMap((item): OutboxItem[] => {
    if (item.kind !== "email" || item.payload.template !== "guest_confirmation") return [item];
    if (row.guest_email === "") return [];
    const data = { ...item.payload.data, paidAtShop: true, depositJpy: 0 };
    return [{ ...item, payload: { ...item.payload, data } }];
  });
}

/**
 * Books the least-used free bike of the model for a guest who pays at the shop, or names why not. `input` comes from a
 * request body, so nothing about it is taken from its type. The guest is checked as at checkout, except that the email may
 * be blank. Every pickup-window rule of a web hold applies but the lead time: a pickup is TOO_SOON only once its slot has
 * ended. `input.id` is the caller's idempotency key: the same request under a stored id gets that booking as it now
 * stands, and anything else under it, a web booking's id included, gets CONFLICT.
 */
export async function createStaffBooking(
  db: D1Database,
  input: StaffBookingInput,
  now: number,
  ctx: StaffBookingContext,
): Promise<StaffBookingResult> {
  // Object() because null or a number has no fields to read.
  const { id, modelId, packageId, startAt, locale, guest } = Object(input) as Record<keyof StaffBookingInput, unknown>;
  const asked = Object(guest) as Record<keyof Guest, unknown>;

  // No reason is declared for either of these, and CONFLICT is the one that says the request cannot stand as written.
  if (!isKey(id) || !isLocale(locale)) return refuse("CONFLICT");

  const settle = (booking: Booking): StaffBookingResult => {
    const same =
      booking.source === "staff" &&
      booking.modelId === modelId &&
      booking.packageId === packageId &&
      booking.startAt === startAt &&
      booking.locale === locale &&
      booking.guestFamilyName === asked.familyName &&
      booking.guestGivenName === asked.givenName &&
      booking.guestEmail === asked.email &&
      booking.guestPhone === asked.phone;
    return same ? { ok: true, booking } : refuse("CONFLICT");
  };

  // Before anything else, so that a replay is answered from the booking, whatever the catalog or the clock now say.
  const stored = await getBooking(db, id);
  if (stored !== null) return settle(stored);

  // A blank email is allowed (owner): the guest gave none, so no confirmation goes out. It is stored blank, as given.
  const fields = validateGuest(guest).filter((code) => !(code === "EMAIL_MALFORMED" && asked.email === ""));
  if (fields.length > 0) return { ok: false, reason: "INVALID_GUEST", fields };
  const { familyName, givenName, email, phone } = guest as Guest;

  const checked = await checkRental(db, modelId, packageId, startAt, now, "slot");
  if (!checked.ok) return checked;

  const { startAt: start, endAt, bufMs } = checked.rental;
  const ahead = bookedAhead(now, start) ? 1 : 0;
  const texts = await db.prepare(TEXTS_SQL).bind(modelId, packageId).first<Texts>();
  const queue = db.prepare(QUEUE_SQL);
  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt += 1) {
    const ref = randomRef();
    const row: ConfirmationRow = {
      id,
      ref,
      vehicle_plate: "",
      start_at: start,
      end_at: endAt,
      price_jpy: null,
      locale,
      guest_family_name: familyName,
      guest_given_name: givenName,
      guest_email: email,
      guest_phone: phone,
      model_texts: texts?.model_texts ?? null,
      package_texts: texts?.package_texts ?? null,
    };
    const items = await staffItems(db, row, ctx);
    const [taken] = await db.batch<BookingRow>([
      db
        .prepare(STAFF_SQL)
        .bind(start, endAt, bufMs, now, modelId, id, ref, locale, packageId, ahead, familyName, givenName, email, phone),
      ...items.map((item) => queue.bind(item.kind, item.dedupeKey, JSON.stringify(item.payload), now, id, ref)),
    ]);
    const inserted: BookingRow | undefined = taken.results[0];
    if (inserted !== undefined) return { ok: true, booking: toBooking(inserted) };

    // Nothing was inserted. A rival under this id decides it, a taken ref earns another try, and otherwise no bike was free.
    const rival = await getBooking(db, id);
    if (rival !== null) return settle(rival);
    const refTaken = await db.prepare("SELECT 1 FROM bookings WHERE ref = ?1").bind(ref).first();
    if (refTaken === null) break;
  }
  return refuse("SOLD_OUT");
}
