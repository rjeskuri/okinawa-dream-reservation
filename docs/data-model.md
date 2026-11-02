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
| unit | a vehicle (`vehicles`) |
| booking: hold, then confirm, then cancel | a booking (`bookings`): ON_HOLD, then CONFIRMED, then CANCELLED |

PAYMENT_PENDING and EXPIRED are used internally.

## Tables

### Catalog

Staff publish these from the Google Sheet, and one publish replaces them together.

| Table | Holds |
| --- | --- |
| `catalog_meta` | One row: the published version, when, and whether it came from `sheet` or `admin`. |
| `vehicle_types` | `scooter`, `motorcycle` or `car`, each with its deposit. |
| `rate_classes` | The rows of the shop's fee schedule, for example 125cc or K-Car, in group `bike` or `car`. |
| `models` | What a guest books: type, rate class, engine, license class and photos. A model carries no prices. |
| `packages` | A rental length: exactly one of `days` (1 to 60) or `hours` (1 to 72). |
| `prices` | The price of one package in one rate class. A model inherits its class's prices. |
| `options` | Priced extras shown on the fee schedule. Choosing them while booking is out of scope. |
| `vehicles` | One bike or car, by plate, with status `active`, `maintenance` or `retired`. |
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
| `refunds` | Square refunds of a booking, from a guest's `cancel` or the Square `dashboard`. |
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
- `CONFIRMED -> CANCELLED`: the guest cancels from the email link, or a block leaves the sheet.

The other paths:

- `ON_HOLD -> EXPIRED`: the hold passes `expires_at` unpaid. It stops blocking at that moment, with no cleanup job.
- `PAYMENT_PENDING -> ON_HOLD`: the card was declined, so the hold returns with its original expiry and the guest can retry.
- `PAYMENT_PENDING -> EXPIRED`: no payment found in Square for a booking stuck in PAYMENT_PENDING.

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

A package returns by closing time on its last day, not N x 24 hours later: `rentalEnd` gives `shop_close` (JST) on the
JST date of the pickup plus days - 1. A one-day package is the shop's same-day rental and returns at `shop_close` that
day, and a three-day package picked up on day D returns at `shop_close` on D + 2.

`rentalEnd` is the only place a rental's end is computed. It throws RangeError for an hours package until task #50 sets
that rule.
