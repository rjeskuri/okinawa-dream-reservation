# OTA connection design

Task #49. Research date 2026-11-02. Nothing here is built, and nothing was tested against an OTA or a vendor.

## Recommendation

Expose OCTO supplier endpoints from this Worker (option A), Klook first. D1 stays the only owner of availability, so the
one conditional insert in `src/lib/booking/holds.ts` stays the only lock. Build nothing until the gate questions in
[Open questions](#open-questions) are answered (the Klook questions, and which OTAs the shop wants). They have three
outcomes:

1. Klook accepts a direct OCTO connection: build option A (T1 to T10).
2. Klook accepts only through a channel manager, or Viator or GetYourGuide become worth reaching (neither takes OCTO
   from us directly, as far as the sources show): reprice the Bokun Channel Manager (T11) and decide again. It is also a
   custom integration that we host, so it does not remove the work of running one.
3. Klook declines this shop or this category: build nothing and stay on block rows.

Reject Bokun or Ventrata as the inventory source: either one would end the one-statement lock, and Ventrata would cost
$6,900 a year before any fee.

The earlier mapping `unit = vehicle` in `docs/data-model.md` is wrong and is replaced below.

## Our OCTO mapping

The `unit = vehicle` mapping (`docs/data-model.md` and the outline of #49) does not work. In OCTO a Unit is a ticket
type: the [glossary](https://docs.octo.travel/getting-started/glossary-of-terms.md) says "The ticket type, e.g. Adult,
Child, Senior". When availability is tracked per Unit, `vacancies` is [the maximum remaining quantity across all
units](https://github.com/octotravel/typespec) (`lib/models/Availability.tsp`), not the sum. Five free scooters as five
Units would report 1.

Core OCTO has no rental concept that we found: our search of the OCTO GitHub organisation for rental, vehicle and
turnaround found nothing. The one rental extension we found is Ventrata's
[`octo/rentals`](https://docs.ventrata.com/capabilities/rentals.md), which is not in the octotravel spec and not in
[Klook's capability list](https://klook.gitbook.io/openapi/getting-started/endpoint-and-capabilities.md). The mapping
below is our inference from the schemas.

| OCTO | Here |
| --- | --- |
| product | a model (`models`) |
| option | a package (`packages`) |
| unit | one Unit per option: id `vehicle`, type OTHER. One rented vehicle is one unit item |
| unit item | one booking row |
| availability object | a pickup slot of one model and package |

A physical vehicle stays internal. It may be exposed in `unitItems[].supplierReference`, which is ["A reference the
supplier uses to identify the unit within all bookings"](https://github.com/octotravel/typespec). The type OTHER is in
the enum, but [it has no definition anywhere](https://github.com/octotravel/typespec), and whether Klook's mapping
accepts it is not found. The
[validator](https://github.com/octotravel/validator/blob/main/backend/src/common/validation/supplier/services/validation/context/ProductBookable.ts)
tolerates it: it takes the ADULT unit, else the first.

**Availability.** `POST /availability` per product and option returns one object per pickup slot, as the
[availability page](https://docs.octo.travel/octo-api-core/availability.md) says a check returns "an object for each
individual departure time (or day)".

- `vacancies`: the free active bikes across the whole span [start, rentalEnd) plus turnaround. This is the `COUNT(*)` of
  `SEARCH_SQL` in `src/lib/booking/availability.ts`, for one model and one package.
- `capacity`: the active vehicles of the model.
- `localDateTimeEnd`: `rentalEnd` from `src/lib/db/blocking.ts`. It is ["the end time for this availability in the
  product's local time zone"](https://github.com/octotravel/typespec), with no same-day rule.
- Turnaround and return-by-closing are ours alone. In core OCTO the availability check and the [reservation
  body](https://github.com/octotravel/typespec/blob/main/lib/schemas/BookingReservationBody.tsp) carry no turnaround,
  duration or return date, so a guest cannot choose a duration there; duration is descriptive content only.
- A slot outside the pickup window (`pickupWindowError`: lead time, horizon, closed dates, return on a closed date, an
  hours package back after closing) is reported SOLD_OUT or CLOSED. A reserve can still meet a window error: the OTA
  calendar goes stale (see Double booking), and a publish can add a closed date. The table under Headers and errors maps
  each reason.
- Hours packages end `hours` after the pickup (#50) and are options like day packages. Only the listed packages are
  exposed: no rental over 24 hours beyond them, and no extension prices (owner, 2026-11-15).

**Product type.** START_TIME, not OPENING_HOURS: the typespec says START_TIME is ["for products with fixed departure
times"](https://github.com/octotravel/typespec), and our pickups are on a slot grid from `shop_open`
(`pickupSlots` in `src/lib/booking/pickup-window.ts`). With the sheet's example (09:00 to 18:00, 30-minute slots) that
is 18 slots a day, so 18 x 365 = 6,570 objects per option. That is too much to compute and send, so we propose a small
fixed set of OTA pickup times, one or two (a proposal; the count is an open question). Each must be on the grid.

**`maxUnits: 1`.** One booking row is one vehicle, and `createHold` has no way to insert two rows atomically under one
uuid, so a reserve of more than one unit item is refused. Two scooters are two OCTO bookings. Whether Klook honours
`maxUnits` is an open question.

**Bookings.** ON_HOLD, then CONFIRMED, then CANCELLED, and EXPIRED, as in the
[bookings page](https://docs.octo.travel/octo-api-core/bookings.md). There is no PAYMENT_PENDING on this path because the
OTA collects payment; that state stays internal. We set
[`instantConfirmation: true`](https://github.com/octotravel/typespec/blob/main/lib/models/Product.tsp), so PENDING
(["Awaiting external confirmation"](https://github.com/octotravel/typespec/blob/main/lib/models/Booking.tsp)) is unused;
REJECTED and REDEEMED are not used (see the voucher below). An unexpired ON_HOLD row blocks its bike in
`BLOCKING_SQL`, so a confirm of an unexpired hold cannot lose the bike.

- **Expiry.** Nothing writes EXPIRED: `isBlocking` has no cleanup job, so a lapsed hold stays `ON_HOLD` in D1. The OCTO
  layer derives EXPIRED on every read (get, list, a uuid replay) from `ON_HOLD AND expires_at <= now`, the test
  `BLOCKING_SQL` uses. A uuid replay after a lapse returns that EXPIRED booking and never takes a new hold; a new hold
  needs a new uuid. `docs/data-model.md` now says EXPIRED is reported to OTAs.
- **Confirm.** A conditional update on `status = 'ON_HOLD' AND expires_at > now`. A confirm of a lapsed hold fails with
  INVALID_BOOKING_UUID and changes nothing: the [OCTO](https://docs.octo.travel/getting-started/errors.md) and
  [Klook](https://klook.gitbook.io/openapi/getting-started/errors.md) errors pages both give it as "Missing or invalid
  booking uuid, or if you're confirming the booking the booking may have expired already", and UNPROCESSABLE_ENTITY there
  is for a body that is "technically correct but cannot be processed for other reasons". The [confirmation
  body](https://github.com/octotravel/typespec/blob/main/lib/schemas/BookingConfirmationBody.tsp) requires `contact`
  and may carry `resellerReference`. The same D1 batch stores the contact's name, email, phone and locale in the
  `guest_*` and `locale` columns, `resellerReference` as `external_ref` and the channel (from the API key) as
  `external_channel`, so the OTA unique index has data.
- **Sheet.** The Bookings tab changes only when a `sheet_booking` item (`src/lib/outbox.ts`) is queued: `drainOutbox`
  claims it and hands the id to `syncBookingRows` (`src/lib/sheets/bookings-sync.ts`), which reads the booking's
  current row. No caller in `src/` enqueues one yet, so each event that changes what the row shows adds
  `enqueueStatements` to its own D1 batch (T6): confirm, cancel of a CONFIRMED booking, and a contact PATCH. A lapsed
  hold is never on the tab: reserve queues nothing, the sync appends only CONFIRMED and CANCELLED rows, and EXPIRED is
  derived on read, never stored. Cancelling a hold that was never confirmed queues nothing, or the sync would append it as
  CANCELLED. `dedupe_key` is UNIQUE with INSERT OR IGNORE, so a key that repeats is silently dropped for good, and each
  event needs its own: `sheet:<booking id>:<event>:<updated_at>`, with `updated_at` the value the same batch writes. No
  code in `src/` builds a key yet; the `sheet:<id>:<status>` in `tests/outbox.test.ts` is a fixture, and it would give a
  contact PATCH on a CONFIRMED booking the confirm's key. Two events on one booking in the same millisecond share a key,
  which is harmless only while the first is unsent. `drainOutbox` has no caller in `src/` and the cron `registry` in
  `src/cron/index.ts` is empty, so nothing delivers these items until #42 lands: T6 depends on #42. `docs/sheet-schema.md`,
  which lists `source` as `web` or `block`, gains the OTA value.

**uuid is `bookings.id`.** The spec says setting the uuid ["acts like an idempotency key preventing you from double
booking"](https://docs.octo.travel/octo-api-core/bookings.md). The uuid is optional in the [reservation
body](https://github.com/octotravel/typespec/blob/main/lib/schemas/BookingReservationBody.tsp), so we mint an id when it
is absent. `createHold` already works this way, but its `settle` compares model, package, start and locale. `contact`,
which carries `locales` ([Contact](https://github.com/octotravel/typespec/blob/main/lib/models/Contact.tsp)), is
optional at reserve, so the reserve path passes a fixed locale (for example `en`) to keep `settle` stable, and confirm
then stores the contact's locale. So that a replay after confirm still matches, `settle` compares only model, package
and start on the OTA source (T3). What a repeated uuid returns is not found in the bookings page we read; ours is: the
same request returns the booking as it now stands, with EXPIRED derived as above, and a different request under that id
is refused as CONFLICT.

**Hold length.** `utcExpiresAt` is `expires_at`. The spec holds availability for `expirationMinutes` "up to an internal
limit set by either the supplier or the OCTo provider" ([bookings page](https://docs.octo.travel/octo-api-core/bookings.md)).
We honour it up to a cap. `hold_minutes` is 15 in the sheet example; we propose a cap of 30 minutes (a proposal; the
Bokun fallback needs an hour, see there). Today `createHold` computes the expiry from `holdMinutes` alone, so it needs
an expiry parameter.

**Cancel and cutoff.** An option has [one cutoff and no tiers](https://github.com/octotravel/typespec)
(`cancellationCutoff`, amount and unit), while we have `cancellation_tiers`. `quoteCancellation` in
`src/lib/booking/cancel.ts` already refuses any booking whose source is not `web`, so the guest cancel link never applies
to an OTA booking; a cancel arrives as `POST /bookings/{uuid}/cancel`. The spec allows it [only when `cancellable` is
true and inside the cutoff](https://docs.octo.travel/octo-api-core/bookings.md). We assume the OTA, which holds the
payment, refunds the guest, so no Square refund runs on this path; no source we read says so, and it is an open
question. Which cutoff to publish, and whether the OTA's policy matches the web tiers, are open questions too.

**Payment.** An OTA booking has no Square payment and no deposit, so "every deposit and refund reconciles with Square"
does not apply to it. These bookings need their own reconciliation against the OTA's statement. The OTA path uses
neither the web price nor the web deposit: its hold writes `deposit_jpy` NULL and `price_jpy` = the retail price.
`HOLD_SQL` takes both from the catalog, so T3 gives `createHold` an OTA variant of the insert (still one conditional
insert), and T2 adds one column, `net_jpy`. Whether the guest still pays a deposit at the shop is an open question.

**Price.** [`retail` and `net`](https://github.com/octotravel/typespec) are integers; the
[pricing page](https://docs.octo.travel/capabilities-optional/pricing.md) gives "USD = 2 and JPY = 0" as the precision.
Pricing is per unit only, because Klook [removed pricing per booking on 20 Nov
2024](https://klook.gitbook.io/openapi/getting-started/specs-updates.md). Klook says `retail` is ["The selling price
Klook will show & charge to customers"](https://klook.gitbook.io/openapi/capabilities/pricing.md) and `net` is the
wholesale rate the supplier charges Klook. `prices` has no net price, so the sheet needs a net price or a commission
rate. "Site prices equal the last published sheet" must then extend to OTA retail, or be explicitly waived for it.

**Ids.** In Klook's [integration process](https://klook.gitbook.io/openapi/getting-started/integration-process.md) the
supplier shares "test API credentials and product data with Klook"; the page does not say how Klook maps them. We assume
Klook keeps our product and option ids (to confirm). A publish can change or remove a package (`bookings.package_id` is
deliberately not a foreign key for that reason), so ids sent to an OTA must be stable: a rule is needed for what a
publish may do to a model or package that is mapped, such as refusing to remove it, or closing it while Klook is told.

## Option A: OCTO supplier endpoints on this Worker

**Auth.** OCTO [uses Bearer authentication, recommends one key per reseller-supplier
relationship](https://docs.octo.travel/getting-started/authentication.md), and requires HTTPS. Klook says [the API keys
are generated by the integrating provider](https://klook.gitbook.io/openapi/getting-started/authentication.md), so we
issue them. Store each as a Worker secret or hash it in D1; never on a command line or in the repo.

**Headers and errors.** Requests carry `Authorization`, `Content-Type` and `Octo-Capabilities`, all
[required](https://docs.octo.travel/getting-started/headers.md); responses carry the last two. The
[errors page](https://docs.octo.travel/getting-started/errors.md) says to answer "either a `200 OK` ... or `400 Bad
Request`", while the authentication page says a bad token should [get a 403](https://docs.octo.travel/getting-started/authentication.md).
The two conflict. Proposal: 403 for a bad key, 400 for the rest, then confirm against Klook's test. Klook's example of
no inventory at reserve is the body `{"error":"UNPROCESSABLE_ENTITY","errorMessage":"Activity inventory not
available","productId":"123"}` ([Klook errors](https://klook.gitbook.io/openapi/getting-started/errors.md)). A rejected
reserve maps each `HoldReason` from `createHold` as below (a proposal, to confirm against Klook's test):

| `HoldReason` | OCTO error | `errorMessage` |
| --- | --- | --- |
| SOLD_OUT, NO_PRICE | UNPROCESSABLE_ENTITY | Activity inventory not available |
| TOO_SOON, TOO_FAR | UNPROCESSABLE_ENTITY | Availability is outside the booking window |
| CLOSED_PICKUP, CLOSED_RETURN, OUTSIDE_HOURS, RETURN_OUTSIDE_HOURS | UNPROCESSABLE_ENTITY | Availability is closed |
| OFF_SLOT | INVALID_AVAILABILITY_ID | Unknown availability (we issue ids on the slot grid only) |
| UNKNOWN_MODEL | INVALID_PRODUCT_ID | Unknown product |
| UNKNOWN_PACKAGE | INVALID_OPTION_ID | Unknown option |
| CONFLICT | BAD_REQUEST | The booking uuid is invalid or already used by a different booking |

**Who accepts OCTO directly.** "Live" is from the Reseller tab of OCTO's [Known Implementations
sheet](https://docs.google.com/spreadsheets/d/1UIgUYAPO3SUsdoGmg5xIGHIBHWHOx7XfQCOzOTML6ms) (titled "Updated: August
2026"). It describes the reseller's implementation, not whether it onboards a shop of our size.

| OTA | What the sources show |
| --- | --- |
| Klook | Live, Core and pricing. Its [OCTO docs](https://klook.gitbook.io/openapi/readme.md) are for "merchants, reservation systems & channel managers". No size, volume or certification gate in the pages read |
| KKday | Live, Core and pricing in the sheet. KKday's own supplier docs: not found |
| Tiqets, Headout | Live in the sheet. Whether a self-hosted endpoint qualifies: not found |
| Viator | Sheet: Unknown. [Access is restricted](https://docs.viator.com/supplier-api/technical/) to registered operators and their authorized reservation system providers, after formal approval |
| GetYourGuide | Sheet: Unknown. Has [its own supplier spec](https://integrator.getyourguide.com/assets/api_documentation/supplier-api-supplier-endpoints.yaml), not OCTO |
| Expedia | Sheet: Unknown. No supplier doc found |
| Rakuten Travel Experiences, Jalan, Asoview | In neither the sheet nor the [member list](https://octo.travel/api/members). No public supplier API found |

**Capabilities.** [Pricing is mandatory](https://klook.gitbook.io/openapi/getting-started/endpoint-and-capabilities.md)
for Klook; content is offered. Nothing else at first (pickups and webhooks are marked Coming Soon there). We build all
OCTO Core, including Update and Extend, which Klook's endpoint table omits, because OCTO's
[Core is "required"](https://docs.octo.travel/getting-started/endpoints-and-capabilities.md). The
[Self-Certification Tool](https://docs.octo.travel/additional-resources/self-certification-tool.md) wants a 100% run, but
as far as any OTA doc read shows the certificate is optional, and no OTA requiring it was found. It is not the reason
for building Core, and **a 100% validator run, so a valid OCTO certificate, is out of reach under this design**: see
the next two bullets and question 2. The tool is not a functional or performance test. We run the
[validator](https://github.com/octotravel/validator) as a check: it requires `allDay` to equal `type === OPENING_HOURS`
and disagrees with the typespec on opening hours, which our START_TIME avoids.

- **Calendar.** `POST /availability/calendar` (one object per day) is Core, so T4 builds it from the same computation as
  `/availability`. Klook does not use it: its calendar section is struck through.
- **Update.** The [`BookingUpdateBody`](https://github.com/octotravel/typespec/blob/main/lib/schemas/BookingUpdateBody.tsp)
  accepts `productId`, `optionId` and `availabilityId`, so a PATCH could move a booking, which needs a second lock. At
  first `PATCH /bookings/{uuid}` refuses those three (UNPROCESSABLE_ENTITY) and takes contact and notes; a move is a
  cancel plus a new booking. **The validator's Update flow would not accept this.** The
  [flow](https://github.com/octotravel/validator/blob/main/backend/src/common/validation/supplier/services/validation/Flows/Booking/BookingUpdateFlow.ts)
  always runs three scenarios: "Booking Update - Change Date" (a PATCH with another `availabilityId`), "Booking Update -
  Unit Items" (a PATCH with three unit items on a booking of two) and "Booking Update - Contact". It adds "Booking Update
  - Change Product" (`productId`, `optionId`, `availabilityId`, `unitItems`) when two or more products are bookable. Only
  contact passes under the refusal. A conditional reassign like #21's edited blocks would fix Change Date (and Change
  Product, if it can move a booking to another product) and is optional work; Unit Items cannot pass at `maxUnits` 1.
- **Why 100% is unreachable.** The validator reads `maxUnits` only to size its default reservation. Two scenarios of its
  [Confirmation flow](https://github.com/octotravel/validator/blob/main/backend/src/common/validation/supplier/services/validation/Flows/Booking/BookingConfirmationFlow.ts),
  "Booking Confirmation unitItems update" and "Booking Confirmation Invalid Unit ID (400 INVALID_UNIT_ID)", and the
  Update flow's "Booking Update - Unit Items" all reserve with an explicit `unitItemsQuantity: 2`, which ignores
  `maxUnits`. We refuse a reserve of two unit items, because a booking row is one vehicle and `createHold` has no atomic
  two-row insert, so each ends in "Reservation Creation Failed". Under this design the run fails those three, plus Change
  Date (and Change Product when it runs) unless the reassign is built. Atomic multi-row holds are not worth building for a
  certificate no OTA doc requires, so `maxUnits` stays 1. If Klook does require the certificate or a validator pass
  (question 2), multi-unit bookings and the conditional reassign become required work and the ticket list must grow
  before the build. Klook's endpoint table has no Update, so Update is no gate for Klook. We read the validator and did
  not run it, and did not check whether the Self-Certification Tool runs the same flows.

**Effort** (our estimate): about 10 tickets (T1 to T10), 5 of them M, sized in [Phase-2 tickets](#phase-2-tickets).

**Load.** Klook says it uses `POST /availability` to ["sync both remaining inventory &
price"](https://klook.gitbook.io/openapi/api-core-mandatory/availability.md), at a frequency "configurable by Klook based
on individual connections", for example "sync every 4 hours for the next 365 days". It pulls per product and option, so
a sync is models x packages x slots x 365 objects. As an illustration only, 10 models x 4 packages x 2 pickup times x 365
is 29,200 objects. On Cloudflare's [Free Workers plan](https://developers.cloudflare.com/workers/platform/limits/) a
request gets 10 ms of CPU, and [D1 allows 50 queries per invocation on Free](https://developers.cloudflare.com/d1/platform/limits/)
(1,000 on Paid). So one call computes its vacancies from one query over the vehicles and their blocking bookings, then
counts in memory, or reads a day-level cache. If 10 ms of CPU still is not enough, this forces Workers Paid (if the
project is on Free), a cost we did not look up. This matches the 20-changes cap that #21 uses for the same reason.

**Double booking.** The reserve is the same `HOLD_SQL` conditional insert, so a stale OTA calendar causes a rejected
reserve and never an overlap. The cost of staleness is rejected sales: Klook pulls, and our search of Klook's docs found
no push (OCTO's Notifications capability is a "placeholder" in [What's New](https://docs.octo.travel/readme.md)), so a
bike taken on the web may stay on offer at Klook until the next sync. A slot open at 25 hours with `min_lead_hours` 24
is TOO_SOON an hour later, so staleness can also cause a window error.

**Voucher.** In Klook's [integration process](https://klook.gitbook.io/openapi/getting-started/integration-process.md)
they "scan the voucher's QR code or barcode to confirm its validity". We need a scannable voucher, and who issues it is
not found. Redemption has no matching state in our model; OCTO has [REDEEMED, "the booking has been
used"](https://github.com/octotravel/typespec). Whether it ever matters here (the counter hands over a bike, nothing
else) is for the shop to say.

## Option B: a reservation system

| Variant | Availability owner | Sync | Double-booking risk | Cost |
| --- | --- | --- | --- | --- |
| Bokun as the source | Bokun | Site reads Bokun | The site's hold crosses two systems with no atomic step | Plans from $49 a month plus a fee |
| Bokun Channel Manager, D1 master | D1 | Bokun calls our plugin; we nudge | Low: reserve is our insert | App price unpublished |
| Ventrata as the source | Ventrata | OTAs connect to Ventrata; the site would read Ventrata (our inference) | The site's hold crosses two systems, as with Bokun as the source | $575 a month plus 2% |
| Ventrata over a backend | D1 | Ventrata calls our OCTO API | Low: reserve is our insert | $575 a month plus 2% |

**Bokun as the source.** D1 stops owning availability and the site's hold would cross two systems with no atomic step,
which breaks the one-statement lock in `holds.ts`. Bokun's own rental pitch is vendor marketing: it says [each rental length is
its own listing](https://www.bokun.io/bike-rental-booking-software), and no rental type is documented in what we read. Duration listings
that share a fleet need [the combo workaround](https://docs.bokun.io/en/articles/128-how-to-have-multiple-experiences-share-availability).
Whether a multi-day duration holds a resource across every day: not found. Bokun's
[pricing](https://www.bokun.io/pricing) is $49, $149 and $499 a month, with 1.5%, 1.25% and 1% booking fees.

**Bokun Channel Manager with D1 as master.** The closest fit. The external platform ["acts as the master data source for
bookings and availability checks"](https://bokun.dev/channel-manager-api/rGmzgGe66zjtEQ8FUvS8dd/overview/ngZRtjHXMewiomPfARFDfZ),
and only Experiences products are supported there.

- It is a plugin contract, not OCTO, with [Basic auth](https://bokun.dev/channel-manager-api/rGmzgGe66zjtEQ8FUvS8dd/security/4nRbq1wvN7pSEuiANYoa2D)
  and "custom-developed plugins, one for each integration instance".
- Reserve and confirm are two steps. OTA timeouts vary, and [GetYourGuide expects a one-hour
  hold](https://bokun.dev/channel-manager-api/rGmzgGe66zjtEQ8FUvS8dd/step-6-reservation-and-booking/mskv6FZYULNxTHGwwxp4qs).
  It is "generally unacceptable" to fail a confirm after a successful reserve, and a high rate of such failures may get
  the plugin disconnected. Our hold blocks its bike until it expires, so this is satisfiable only if the hold lasts an
  hour: this path needs a one-hour cap, not the 30 minutes proposed for OCTO.
- Our push is a nudge: [at most 1 call per product per minute](https://api-docs.bokun.dev/rest-v2.yaml). A change may take
  [up to 24 hours](https://docs.bokun.io/en/articles/381-allocation-manager) to show on the OTA for allotment changes.
- The availability request carries `range` and `requiredCapacity` and [no rental-length
  field](https://bokun.dev/channel-manager-api/rGmzgGe66zjtEQ8FUvS8dd/step-5-shallow--deep-availability-searches/sPPmgCTjTdEPh1R1VfmhZp)
  is documented, so probably one Bokun product per rental length. That is our reading, to be confirmed with Bokun.
- [Prices live in Bokun](https://docs.bokun.io/en/articles/395-what-do-i-manage-in-bokun-and-what-do-i-manage-in-my-own-system),
  a second price source next to the sheet. The app [must be purchased](https://docs.bokun.io/en/articles/394-introduction-to-how-to-create-and-map-channel-manager-products)
  and its price is unpublished; whether a Bokun plan is also needed is not found.
- Booking fees: the [pricing page](https://www.bokun.io/pricing) says "we charge 0.5-1.5% booking fees on Viator for
  Channel Manager". [Article 387](https://docs.bokun.io/en/articles/387-transaction-fee-information) gives the plan
  rates (1.5%, 1.25%, 1.0%), says they include Channel Manager bookings, and calls Viator bookings free. The two pages
  conflict, and Viator is the stated reason for this fallback (question 14).
- Reach is wider: Klook ([Bokun's Klook page](https://docs.bokun.io/en/articles/195-how-to-connect-to-klook)), Viator
  ([Bokun's Viator page](https://www.bokun.io/grow/viator)), GetYourGuide (named on the Channel Manager reservation
  page above), and KKday, which Bokun's [news feed](https://www.bokun.io/feed) names. [Expedia is no longer onboarding
  new suppliers](https://docs.bokun.io/en/articles/202-how-to-connect-bokun-and-expedia) through Bokun.

**Ventrata, as the source or as a channel manager over a backend.** A rental model on paper:
[Rental, Rental Fixed and minimum and maximum duration](https://support.ventrata.com/en/articles/9495702-how-to-create-products),
and [exclusive resources](https://support.ventrata.com/en/articles/9521464-how-to-use-resources-and-resource-groups).
The duration comes through [`octo/rentals`](https://docs.ventrata.com/capabilities/rentals.md), a Ventrata extension
(see the mapping above). That page lists no DAY unit (only HOUR in its example), and every package we expose is
day-based, so the fit is on paper only. The
[Standard plan](https://ventrata.com/compare-our-plans) is $575 a month plus 2%, and the
[terms (cl. 11.2)](https://storage.googleapis.com/ventrata-documents/ventrata-terms-and-conditions.pdf) compute fees on
gross ticket value regardless of channel, commissions deducted or refunds. $575 x 12 is $6,900 a year before any fee (the
arithmetic is ours, in USD), far past the project's goal of fees at zero or minimal. As a backend, Ventrata [connects out
to our system](https://docs.ventrata.com/getting-started/certification/operator-connection-backend.md) and requires "an
OCTO-compliant API covering OCTO Core", with a desired response under 1 s. It is written for a third-party Supplier
reselling; whether a shop can be its own Supplier with our Worker as Backend is not found. Whether `octo/rentals` passes
through a backend is not found.

**Under every variant**, each OTA still needs its own commercial contract: [Bokun says to sign up with the OTAs
directly](https://docs.bokun.io/en/articles/373-online-travel-agency-ota), and Ventrata's Klook page requires ["a
commercial agreement with Klook"](https://support.ventrata.com/en/articles/9527504-klook-reseller-connection).

**What carries over from A to B.** An OCTO API carries to the Ventrata Backend and not to Bokun's plugin, which is a
different contract. The reserve, hold, cancel and availability code in `src/lib` carries to both.

## Comparison

| | A: OCTO on our Worker | Bokun Channel Manager | Ventrata |
| --- | --- | --- | --- |
| Fixed cost | None from a vendor; Workers Paid if the limits force it | App price unpublished | $575 a month (Standard) |
| Per booking | None found | 0.5-1.5% on Viator ([pricing](https://www.bokun.io/pricing)) or the plan's 1.5%, 1.25% or 1.0% ([article 387](https://docs.bokun.io/en/articles/387-transaction-fee-information)); the pages conflict | 2% of gross, unreduced |
| Availability owner | D1 | D1 (master) | Ventrata, or D1 as backend |
| Channels | Klook documents it; KKday, Tiqets and Headout are unconfirmed | Klook, Viator, GetYourGuide, KKday | [Klook](https://support.ventrata.com/en/articles/9527504-klook-reseller-connection), [KKday](https://support.ventrata.com/en/articles/9527544-kkday-reseller-connection), [Viator](https://support.ventrata.com/en/articles/9527434-viator-reseller-connection), [GetYourGuide](https://support.ventrata.com/en/articles/9526754-getyourguide-reseller-connection) |
| Integration work | All of OCTO Core, voucher, reconciliation | A plugin, prices in a second place | An OCTO API anyway (as backend) |
| If the vendor goes away | Nothing is lost | We keep D1; the plugin is thrown away | As backend, the OCTO API stays |
| Japan OTAs (Rakuten, Jalan, Asoview) | Not found | Not found; the full list is login-only | Not found |

## Retiring block rows

This builds on #21.

- **Per channel, not all at once.** After a channel goes live, new bookings on it arrive as OCTO bookings. Bookings
  already on the sheet stay as block rows and end on their own, since #21 leaves ended blocks alone.
- **A warning, not an error.** Publish should warn on a new Blocks row naming a connected channel, because that row would
  hold a second bike for a booking that may also arrive through OCTO. The `channel` column is free text (`Klook`), so the
  warning needs a list of connected channels, in config or a constant.
- **The Blocks tab stays.** Walk-ins and unconnected channels keep using blocks.
- **The rule from #21 stays:** emptying the tab cancels nothing and reports an error.
- **Cutover risk.** A booking made on Klook before the connection may not be re-sent; if it could be, it would double up
  with its block row. This needs checking with Klook.

Schema changes:

- `bookings.source` has `CHECK (source IN ('web','block'))`. SQLite cannot alter a CHECK, so adding an OTA source needs a
  table rebuild migration. `refunds` references `bookings`, so the rebuild keeps every id.
- `idx_bookings_block_external_ref` is partial on `source = 'block'`. OTA references need their own unique index, for
  example on `(external_channel, external_ref) WHERE source = 'ota'`; confirm fills both columns (see Bookings).
- `HOLD_SQL` hard-codes `'web'` and takes the price and deposit from the catalog, so `createHold` needs a source
  parameter, price and deposit handling for the OTA path, and an expiry parameter (locale is already a parameter).
  `BookingSource` in `src/lib/types.ts` gains the new value. T2 adds one column, `net_jpy`.

## Open questions

The gate questions (1 to 7) block T0 and so every later ticket. Each other question names the tickets it blocks.

**Gate: Klook and the shop**

1. Does Klook accept scooters and motorcycles over OCTO under a merchant contract, for a shop this size?
2. Do they accept type OTHER, multi-day options and `maxUnits` 1? Does Klook require the OCTO certificate or a validator
   pass? If it does, multi-unit bookings and the conditional reassign become required work and the ticket list must grow
   before the build (see Update).
3. What sync frequency would they use for us?
4. What do they do when a reserve is rejected?
5. Can cars go this route? [Klook's merchant page](https://merchant.klook.com/introduction?lang=en-NZ) sends "car rentals"
   to a separate form, and how rental-car suppliers connect is not found.
6. Does a booking made before the connection get re-sent?
7. Which OTAs does the shop actually want, and at what commission?

We could not read the Klook and KKday listing pages, so whether existing Okinawa rental shops connect this way is unknown.

**The shop**

8. Is an OTA guest's balance paid at the shop or all online? The parked question is that the shop's own site says cash
   only. (T8)
9. Is the OTA cancellation policy the same as the web tiers? What cutoff do we publish? (T5, T6)
10. How many OTA pickup times, and which? (T1, T4)
11. Does the OTA get the web lead time and horizon (`min_lead_hours`, `max_days_ahead`)? (T4)
12. Is a net price or a commission rate kept in the sheet? Do we waive "site prices equal the sheet" for OTA retail? (T1, T2)
13. Who refunds the guest when the OTA cancels: the OTA, as we assume? (T6, T8)

**Vendors** (only if the fallback is taken)

14. Bokun: app price, whether a plan is also needed, which fee page applies to Channel Manager bookings (0.5-1.5% on
    Viator, or the plan rate), one product per rental length, and multi-day resource holds. (T11)
15. Ventrata: can a shop be its own Supplier, does `octo/rentals` pass through a backend, and what is the minimum term?
    (No ticket.)
16. Rakuten, Jalan and Asoview are absent from everything read, and they matter for a Japan shop. Is there any supplier
    connection? [Activityboard](https://activityboard.jp/) says it connects fully with Jalan, a lead not followed up.
    (No ticket.)

**Later**

17. KKday: the same questions as Klook, plus a primary source for supplier onboarding, which is not found. It blocks only
    a future KKday ticket.

## Phase-2 tickets

Not created on GitHub. Sizes are our estimate. T1 to T10 wait on T0 and on gate outcome 1; T11 only on outcome 2. If
question 2 says Klook requires the certificate, this list grows before the build.

| # | Ticket | Size | Depends on |
| --- | --- | --- | --- |
| T0 | Answer the gate questions 1 to 7 with Klook and the shop (non-code), and record the outcome | S | |
| T1 | Sheet: OTA pickup times, net price or commission, mapped ids and connected channels; validation and docs | M | T0, questions 10, 12 |
| T2 | Migration: rebuild `bookings` with the OTA source, OTA reference index and one new column, `net_jpy` | S | T0, question 12 |
| T3 | `createHold`: source, OTA price and deposit handling (`deposit_jpy` NULL, `price_jpy` retail), expiry parameter; `settle` ignores locale on the OTA source; same conditional insert | S | T2 |
| T4 | Availability for OCTO: vacancies by slot in one query, with a day-level cache, and `POST /availability/calendar` | M | T1, questions 10, 11 |
| T5 | OCTO read side: auth, headers, errors, `/supplier`, `/products`, content, pricing | M | T1, question 9 |
| T6 | OCTO bookings: reserve, confirm (guest fields, `external_ref`, `external_channel`, derived EXPIRED), cancel, get, list, update (contact and notes only), extend; an outbox item per event that changes the row (confirm, cancel, contact PATCH) with its own `dedupe_key`; the `docs/sheet-schema.md` source value | M | T3, T4, T5, #42, questions 9, 13 |
| T7 | Voucher with a QR or barcode, and the counter check | S | T6 |
| T8 | OTA reconciliation against the OTA's statement | M | T6, questions 8, 13 |
| T9 | Publish warning on Blocks rows for a connected channel, and the cutover | S | #21, T6 |
| T10 | Klook's own test passes, and a validator run is recorded in the ticket with only the named failing scenarios (see Update); go live | S | T6, T7, T8, T9 |
| T11 | Only for gate outcome 2: Bokun Channel Manager plugin spike, with a one-hour hold cap | M | T0, question 14 |

## What was not verified

Documentation only. There was no sandbox and no OTA or vendor was contacted. The OCTO validator was read, not run. The
Klook and KKday listing pages could not be read (they returned 403 or script only), so nothing here says how existing
shops are listed. Headout's help page was unread, so only the OCTO sheet's line is used for it. Bokun's OTA page (the
"sign up with these OTAs directly" quote) returned only its title on a later fetch, so that quote comes from the earlier
read. Research date: 2026-11-02; the OCTO sheet is titled "Updated: August 2026", and OCTO 2.0 is [in community
review](https://www.octo.travel/specification), so details may move.
