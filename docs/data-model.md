# Data model

The D1 schema in `migrations/0002_core.sql`, the booking lifecycle and the rule that prevents double-bookings. The
domain types are in `src/lib/types.ts`; the rule is in `src/lib/db/blocking.ts`.

Times are INTEGER epoch ms UTC, with JST through `src/lib/time.ts`. Money is INTEGER JPY. A `texts` column is JSON keyed
by locale, for example `{ "ja": { "name": "..." }, "en": { "name": "..." } }`.

## OCTO mapping

The model is shaped on OCTO, so the OTA connection designed in task #49 can map onto it.

| OCTO | Here |
| --- | --- |
| product | a model (`models`) |
| option | a package (`packages`) |
| unit | one `vehicle` unit per option, not a physical vehicle: see `docs/ota-design.md` |
| booking: hold, then confirm, then cancel | a booking (`bookings`): ON_HOLD, then CONFIRMED, then CANCELLED |

PAYMENT_PENDING is used internally. EXPIRED is reported to OTAs, as designed in `docs/ota-design.md`.

## Tables

Every table is `STRICT`, so SQLite refuses a value that is not of the column's declared type: text or a fraction in a money, time or count column fails the insert instead of being stored.

### Catalog

Staff publish these from the Google Sheet, and one publish replaces them together.

| Table | Holds |
| --- | --- |
| `catalog_meta` | One row: the published version, when, and whether it came from `sheet` or `admin`. |
| `vehicle_types` | `scooter`, `motorcycle`, `car` or `ebike`, each with its deposit. |
| `rate_classes` | The rows of the shop's fee schedule, for example 125cc or K-Car, in group `bike`, `car` or `ebike`. |
| `models` | What a guest books: type, rate class, engine, license class and photos. A model carries no prices. An e-bike has no engine and needs no license: `engine_cc` may be NULL and `license_class` may be `none` only on type `ebike`, and table CHECKs refuse either on any other type. |
| `packages` | A rental length: exactly one of `days` (1 to 60) or `hours` (1 to 72). |
| `prices` | The price of one package in one rate class. A model inherits its class's prices. `advance_price_jpy`, NULL for none and never above `price_jpy`, is what a hold made before the pickup's JST date locks into `bookings.price_jpy` instead. |
| `options` | Priced extras shown on the fee schedule, in group `bike`, `car` or `ebike`. Choosing them while booking is out of scope. |
| `vehicles` | One bike, car or e-bike, by plate, with status `active`, `maintenance` or `retired`. |
| `config` | The shop settings as text, read through `readShopConfig`. |
| `cancellation_tiers` | The refund percent from a number of days before pickup. |
| `closed_dates` | Dates the shop is closed, as YYYY-MM-DD. |

Models and vehicles are never deleted, because bookings reference them: a publish deactivates or retires them instead.
`bookings.package_id` is deliberately not a foreign key, because a package can leave the catalog while bookings of it
remain.

`replaceCatalog` in `src/lib/db/catalog-store.ts` writes a publish in one D1 batch, so a failure leaves the previous
catalog and version. Packages, prices, options, config, refund tiers and closed dates are replaced whole. A vehicle type
or rate class the catalog no longer names leaves with it, unless a model, kept inactive ones included, still references
it. `readCatalog` returns every row, so callers filter out inactive models and retired vehicles.

A publish reports the bookings it affects: blocking bookings that end after now, on a vehicle whose status after the
publish is not `active`.

### Bookings and bookkeeping

| Table | Holds |
| --- | --- |
| `bookings` | One rental of one vehicle. `web` bookings come from guests. `block` bookings come from the sheet's OTA blocks, with `external_ref` unique among them. |
| `refunds` | Square refunds of a booking, from a guest's or staff's `cancel` or the Square `dashboard`. |
| `outbox` | Emails and sheet updates waiting to be sent, each unique by `dedupe_key`. |
| `webhook_events` | Square events already handled, by event id. |
| `photos` | Vehicle photos copied from Drive to R2. |
| `kv_cache` | Short-lived values with an expiry. |

The Worker's own `cron_runs` and `meta` tables are in `migrations/0001_init.sql`.

## Booking statuses and transitions

| Status | Meaning | Blocks the vehicle |
| --- | --- | --- |
| ON_HOLD | A vehicle is held for a guest until `expires_at`. | While `expires_at` > now |
| PAYMENT_PENDING | A charge is in flight, or its outcome is unknown. | Always |
| CONFIRMED | The deposit is paid, or a staff block is in place. | Always |
| CANCELLED | The booking was cancelled. | Never |
| EXPIRED | The hold lapsed, or no payment was found for it. | Never |

The main path is `ON_HOLD -> PAYMENT_PENDING -> CONFIRMED -> CANCELLED`:

- `ON_HOLD -> PAYMENT_PENDING`: the guest submits payment while the hold is unexpired.
- `PAYMENT_PENDING -> CONFIRMED`: Square reports the payment completed for the right amount.
- `CONFIRMED -> CANCELLED`: the guest cancels from the email link, staff cancel a web booking from the Dashboard, or a
  block leaves the sheet. `cancel_reason` is `guest` or `staff`. The guest's link closes at pickup; staff can also cancel
  a no-show, at the tier for 0 days before. Staff choose the tier refund, all that was paid less earlier refunds, or none,
  and `refund_due_jpy` records the total refund they settled on: the refunds before it plus this one. It stays NULL on a
  guest's cancellation, a block and any booking staff did not cancel. Both cancellations land in one batch under the same
  guard and refund key `rf:<id>`, and call Square only after it.

The other paths:

- `ON_HOLD -> EXPIRED`: the hold passes `expires_at` unpaid. It stops blocking at that moment, with no cleanup job.
- `PAYMENT_PENDING -> ON_HOLD`: the card was declined, or the payment took another amount or currency and went back in
  full, so the hold returns with its original expiry and the guest can retry.
- `PAYMENT_PENDING -> EXPIRED`: no payment found in Square for a booking stuck in PAYMENT_PENDING.
- `CANCELLED -> CONFIRMED`: a block's row returns to the sheet before the block's end and the overlap rule still lets it.
  Web bookings have no way back.

`syncBlocks` in `src/lib/booking/blocks.ts` writes block bookings. `content_hash` is a digest of the row as last synced,
so an unchanged row costs no write, then after a dot a digest of that row's plate alone. A staff override changes
`vehicle_plate` and leaves `content_hash` alone, so the plate digest is how a sync tells an edit to the row's plate,
which moves the block, from an edit to its other columns, which keeps the override. Any write that takes a vehicle
picks it inside that one conditional statement, as a hold does. Blocks that have ended are never written again, and at
most 20 changes run per call. `docs/sheet-schema.md` says what staff see.

## The overlap rule

Booking b blocks its vehicle when its status is CONFIRMED or PAYMENT_PENDING, or ON_HOLD with `expires_at` > now.

A candidate [s, e) on the same vehicle conflicts with b when `b.start_at < e + buf` and `s < b.end_at + buf`, where
`buf` is config `turnaround_minutes` x 60000. So a 10:00 return with 60 minutes of buffer blocks a 10:30 pickup and
allows 11:00, and with no buffer two rentals that only touch do not conflict.

`isBlocking` and `conflicts` state the rule in JS, and `BLOCKING_SQL` and `OVERLAP_SQL` state it in SQL. The SQL
fragments read booking alias `b` and a parameter CTE that a statement declares once, because D1 has no named parameters:

```sql
WITH q(s, e, buf, now) AS (SELECT ?1, ?2, ?3, ?4)
SELECT b.id FROM bookings b WHERE b.vehicle_plate = ?5 AND <BLOCKING_SQL> AND <OVERLAP_SQL>
```

## When a rental ends

A days package returns by closing time on its last day, not N x 24 hours later: `rentalEnd` gives `shop_close` (JST) on
the JST date of the pickup plus days - 1. A one-day package is the shop's same-day rental and returns at `shop_close`
that day, and a three-day package picked up on day D returns at `shop_close` on D + 2.

An hours package returns `hours` after the pickup (task #50): a 4-hour rental from 10:00 is back at 14:00, and a 24-hour
rental from 17:30 is back at 17:30 the next day. A 24-hour package is not the one-day package, which is back at closing
on the pickup's day; the shop prices them apart.

`rentalEnd` is the only place a rental's end is computed, and availability, holds and the overlap rule all take its end,
with the turnaround buffer after it. It throws RangeError unless exactly one of days and hours is set, to a whole number
of at least 1.

An hours package must be back between `shop_open` and `shop_close`, both included, on the date it returns (owner,
2026-11-15). `pickupWindowError` refuses a pickup that is not with RETURN_OUTSIDE_HOURS, after CLOSED_PICKUP and before
CLOSED_RETURN, and `pickupSlots(config, pkg)` lists only the pickups that are: from 09:00 to 18:00, a 4-hour rental can
start until 14:00 and a 24-hour rental at any slot. CLOSED_RETURN reads the JST date of the return, which for 24 hours is
the next day. A days package returns at closing, so this rule never refuses one.

## Usage for least-used assignment

A hold takes the free bike with the fewest usage days: `base_usage_days` plus one day for each CONFIRMED booking of 24
hours or less, hourly rentals included (owner, 2026-11-15), and the JST dates it touches for each longer one. A booking
counts by its own `start_at` and `end_at`, not its package, because a staff block has none and a package can change.
