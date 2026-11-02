# OTA connection design

Task #49. Research date 2026-11-02. Nothing here is built, and nothing was tested against an OTA or a vendor.

## Recommendation

Expose OCTO supplier endpoints from this Worker (option A), Klook first. D1 stays the only owner of availability, so the
one conditional insert in `src/lib/booking/holds.ts` stays the only lock. Build nothing until the gate questions in
[Open questions](#open-questions) are answered: they decide whether Klook takes this shop at all.

Fallback: the Bokun Channel Manager, if Viator or GetYourGuide become worth reaching (neither takes OCTO from us
directly, as far as the sources show) or if the shop will not take on running an integration. Reject Bokun or Ventrata as
the inventory source: either one would end the one-statement lock, and Ventrata would cost $6,900 a year before any fee.

The earlier mapping `unit = vehicle` in `docs/data-model.md` is wrong and is replaced below.

## Our OCTO mapping

The `unit = vehicle` mapping (`docs/data-model.md` and the outline of #49) does not work. In OCTO a Unit is a ticket
type: the [glossary](https://docs.octo.travel/getting-started/glossary-of-terms.md) says "The ticket type, e.g. Adult,
Child, Senior". When availability is tracked per Unit, `vacancies` is [the maximum remaining quantity across all
units](https://github.com/octotravel/typespec) (`lib/models/Availability.tsp`), not the sum. Five free scooters as five
Units would report 1.

No source read documents rentals on OCTO: a search of the OCTO GitHub organisation for rental, vehicle and turnaround
found nothing. The mapping below is our inference from the schemas.

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
accepts it is not found. The validator tolerates it.

**Availability.** `POST /availability` per product and option returns one object per pickup slot, as the
[availability page](https://docs.octo.travel/octo-api-core/availability.md) says a check returns "an object for each
individual departure time (or day)".

- `vacancies`: the free active bikes across the whole span [start, rentalEnd) plus turnaround. This is the `COUNT(*)` of
  `SEARCH_SQL` in `src/lib/booking/availability.ts`, for one model and one package.
- `capacity`: the active vehicles of the model.
- `localDateTimeEnd`: `rentalEnd` from `src/lib/db/blocking.ts`. It is ["the end time for this availability in the
  product's local time zone"](https://github.com/octotravel/typespec), with no same-day rule.
- Turnaround and return-by-closing are ours alone: OCTO has no turnaround concept and no guest-chosen duration (duration
  exists only as descriptive content).
- A slot outside the pickup window (`pickupWindowError`: lead time, horizon, closed dates, return on a closed date) is
  reported SOLD_OUT or CLOSED, so a reserve never meets a window error.
- Hours packages have no end rule until #50, so only day packages are exposed at first.

**Product type.** START_TIME, not OPENING_HOURS: the typespec says START_TIME is ["for products with fixed departure
times"](https://github.com/octotravel/typespec), and our pickups are on a slot grid from `shop_open`
(`pickupSlots` in `src/lib/booking/pickup-window.ts`). With the sheet's example (09:00 to 18:00, 30-minute slots) that
is 18 slots a day, so 18 x 365 = 6,570 objects per option. That is too much to compute and send, so we propose a small
fixed set of OTA pickup times, one or two (a proposal; the count is an open question). Each must be on the grid.

**`maxUnits: 1`.** One booking row is one vehicle, and `createHold` has no way to insert two rows atomically under one
uuid. Two scooters are two OCTO bookings. Whether Klook honours `maxUnits` is an open question.

**Bookings.** ON_HOLD, then CONFIRMED, then CANCELLED, and EXPIRED, as in the
[bookings page](https://docs.octo.travel/octo-api-core/bookings.md). There is no PAYMENT_PENDING on this path because the
OTA collects payment; that state stays internal. We set `instantConfirmation: true`, so PENDING is unused; REJECTED and
REDEEMED are not used (see the voucher below). An unexpired ON_HOLD row blocks its bike in `BLOCKING_SQL`, so a confirm
of an unexpired hold cannot lose the bike. Confirm is a conditional update on `status = 'ON_HOLD' AND expires_at > now`.

**uuid is `bookings.id`.** The spec says setting the uuid ["acts like an idempotency key preventing you from double
booking"](https://docs.octo.travel/octo-api-core/bookings.md). `createHold` already works this way, but its `settle`
compares model, package, start and locale, and OCTO sends no locale. The OCTO path therefore passes a fixed locale (for
example `en`). OCTO does not specify what a repeated uuid returns (not found); ours is: the same request returns the
booking as it now stands, whatever its status, and a different request under that id is refused as CONFLICT.

**Hold length.** `utcExpiresAt` is `expires_at`. The spec holds availability for `expirationMinutes` "up to an internal
limit set by either the supplier or the OCTo provider" ([bookings page](https://docs.octo.travel/octo-api-core/bookings.md)).
We honour it up to a cap. `hold_minutes` is 15 in the sheet example; we propose a cap of 30 minutes (a proposal). Today
`createHold` computes the expiry from `holdMinutes` alone, so it needs an expiry parameter.

**Cancel and cutoff.** An option has [one cutoff and no tiers](https://github.com/octotravel/typespec)
(`cancellationCutoff`, amount and unit), while we have `cancellation_tiers`. `quoteCancellation` in
`src/lib/booking/cancel.ts` already refuses any booking whose source is not `web`, so the guest cancel link never applies
to an OTA booking; a cancel arrives as `POST /bookings/{uuid}/cancel`. The spec allows it [only when `cancellable` is
true and inside the cutoff](https://docs.octo.travel/octo-api-core/bookings.md). The refund to the guest is the OTA's, and
no Square refund runs on this path. Which cutoff to publish, and whether the OTA's policy matches the web tiers, are open
questions.

**Payment.** An OTA booking has no Square payment and no deposit, so "every deposit and refund reconciles with Square"
does not apply to it. These bookings need their own reconciliation against the OTA's statement. `price_jpy` would hold
the retail price and `deposit_jpy` stay null; whether the guest still pays a deposit at the shop is an open question.

**Price.** [`retail` and `net`](https://github.com/octotravel/typespec) are integers; the
[pricing page](https://docs.octo.travel/capabilities-optional/pricing.md) gives "USD = 2 and JPY = 0" as the precision.
Pricing is per unit only, because Klook [removed pricing per booking on 20 Nov
2024](https://klook.gitbook.io/openapi/getting-started/specs-updates.md). Klook says `retail` is ["The selling price
Klook will show & charge to customers"](https://klook.gitbook.io/openapi/capabilities/pricing.md) and `net` is the
wholesale rate the supplier charges Klook. `prices` has no net price, so the sheet needs a net price or a commission
rate. "Site prices equal the last published sheet" must then extend to OTA retail, or be explicitly waived for it.

**Ids.** Klook maps our product and option ids, and a publish can change or remove a package (`bookings.package_id` is
deliberately not a foreign key for that reason). Ids sent to an OTA must therefore be stable: a rule is needed for what
a publish may do to a model or package that is mapped, such as refusing to remove it, or closing it while Klook is told.

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
reserve returns that, from the failed `createHold` (SOLD_OUT).

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
| Rakuten Travel Experiences, Jalan, Asoview | In neither OCTO list. No public supplier API found |

**Capabilities.** [Pricing is mandatory](https://klook.gitbook.io/openapi/getting-started/endpoint-and-capabilities.md)
for Klook; content is offered. Nothing else at first (pickups and webhooks are marked Coming Soon there). We build all
OCTO Core, including Update and Extend, which Klook's endpoint table omits, because OCTO's
[Core is "required"](https://docs.octo.travel/getting-started/endpoints-and-capabilities.md) and the
[Self-Certification Tool](https://docs.octo.travel/additional-resources/self-certification-tool.md) wants a 100% run. As
far as any OTA doc read shows, the certificate is optional; no OTA requiring it was found. The tool is not a functional
or performance test. Certify against the [validator](https://github.com/octotravel/validator): it requires `allDay` to
equal `type === OPENING_HOURS` and disagrees with the typespec on opening hours, which our START_TIME avoids.

**Effort** (our estimate): about 10 tickets (T1 to T10), 5 of them M. The pieces: a migration for the source and
references; `createHold` taking a source, locale and expiry; availability for a day or a range in one query; auth,
headers and errors; `/supplier`, `/products`, content and pricing; the bookings endpoints; a voucher; reconciliation;
certification and Klook's tests. The list in [Phase-2 tickets](#phase-2-tickets) sizes each.

**Load.** Klook says it uses `POST /availability` to ["sync both remaining inventory &
price"](https://klook.gitbook.io/openapi/api-core-mandatory/availability.md), at a frequency "configurable by Klook based
on individual connections", for example "sync every 4 hours for the next 365 days". It pulls per product and option, so
a sync is models x packages x slots x 365 objects. As an illustration only, 10 models x 4 packages x 2 pickup times x 365
is 29,200 objects. On Cloudflare's [Free Workers plan](https://developers.cloudflare.com/workers/platform/limits/) a
request gets 10 ms of CPU, and [D1 allows 50 queries per invocation on Free](https://developers.cloudflare.com/d1/platform/limits/)
(1,000 on Paid). So one call computes its vacancies from one query over the vehicles and their blocking bookings, then
counts in memory, or reads a day-level cache. If 10 ms of CPU still is not enough, this forces Workers Paid (if the project is on Free), a
cost we cannot quote because the notes hold no Paid price. This matches the 20-changes cap that #21 uses for the same
reason.

**Double booking.** The reserve is the same `HOLD_SQL` conditional insert, so a stale OTA calendar causes a rejected
reserve and never an overlap. The cost of staleness is rejected sales: Klook pulls and the notes show no push (OCTO's
Notifications capability is [a placeholder](https://docs.octo.travel/capabilities-optional/notifications.md)), so a bike
taken on the web may stay on offer at Klook until the next sync.

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
| Ventrata as the source, or over a backend | Ventrata (source), D1 (backend) | Ventrata calls our OCTO API | Low as a backend | $575 a month plus 2% |

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
  the plugin disconnected. Our hold blocks its bike until it expires, so this is satisfiable.
- Our push is a nudge: [at most 1 call per product per minute](https://api-docs.bokun.dev/rest-v2.yaml). A change may take
  [up to 24 hours](https://docs.bokun.io/en/articles/381-allocation-manager) to show on the OTA for allotment changes.
- The availability request carries `range` and `requiredCapacity` and [no rental-length
  field](https://bokun.dev/channel-manager-api/rGmzgGe66zjtEQ8FUvS8dd/step-5-shallow--deep-availability-searches/sPPmgCTjTdEPh1R1VfmhZp)
  is documented, so probably one Bokun product per rental length. That is our reading, to be confirmed with Bokun.
- [Prices live in Bokun](https://docs.bokun.io/en/articles/395-what-do-i-manage-in-bokun-and-what-do-i-manage-in-my-own-system),
  a second price source next to the sheet. The app [must be purchased](https://docs.bokun.io/en/articles/394-introduction-to-how-to-create-and-map-channel-manager-products)
  and its price is unpublished; whether a Bokun plan is also needed is not found.
- Reach is wider: [Klook](https://docs.bokun.io/en/articles/195-how-to-connect-to-klook), Viator, GetYourGuide, and KKday,
  which Bokun's [news feed](https://www.bokun.io/feed) names. [Expedia is no longer onboarding new
  suppliers](https://docs.bokun.io/en/articles/202-how-to-connect-bokun-and-expedia) through Bokun.

**Ventrata, as the source or as a channel manager over a backend.** Best native rental model on paper:
[Rental, Rental Fixed and minimum and maximum duration](https://support.ventrata.com/en/articles/9495702-how-to-create-products),
and [exclusive resources](https://support.ventrata.com/en/articles/9521464-how-to-use-resources-and-resource-groups). But
the [Standard plan](https://ventrata.com/compare-our-plans) is $575 a month plus 2%, and the
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
| Per booking | None found | [Fees on Channel Manager bookings](https://docs.bokun.io/en/articles/387-transaction-fee-information), rate not published | 2% of gross, unreduced |
| Availability owner | D1 | D1 (master) | Ventrata, or D1 as backend |
| Channels | Klook documents it; KKday, Tiqets and Headout are unconfirmed | Klook, Viator, GetYourGuide, KKday | Klook, KKday, [Viator](https://support.ventrata.com/en/articles/9527434-viator-reseller-connection), [GetYourGuide](https://support.ventrata.com/en/articles/9526754-getyourguide-reseller-connection) |
| Integration work | All of OCTO Core, voucher, reconciliation | A plugin, prices in a second place | An OCTO API anyway (as backend) |
| If the vendor goes away | Nothing is lost | We keep D1; the plugin is thrown away | As backend, the OCTO API stays |
| Japan OTAs (Rakuten, Jalan, Asoview) | Not found | Not found; the full list is login-only | Not found |

## Retiring block rows

This builds on #21, which is not built yet, so what follows is what will be true once it lands.

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
  example on `(external_channel, external_ref) WHERE source = 'ota'`.
- `HOLD_SQL` hard-codes `'web'`, so `createHold` needs a source parameter, and the OTA path also needs the locale and
  expiry parameters above. `BookingSource` in `src/lib/types.ts` gains the new value.

## Open questions

The gate questions block T0 and so every later ticket; the others name the tickets they block.

**Gate: Klook**

1. Does Klook accept scooters and motorcycles over OCTO under a merchant contract, for a shop this size?
2. Do they accept type OTHER, multi-day options and `maxUnits` 1?
3. What sync frequency would they use for us?
4. What do they do when a reserve is rejected?
5. Can cars go this route? [Klook's merchant page](https://merchant.klook.com/introduction?lang=en-NZ) sends "car rentals"
   to a separate form, and how rental-car suppliers connect is not found.
6. Does a booking made before the connection get re-sent?

**Gate: KKday**: the same questions, plus a primary source for supplier onboarding, which is not found. We could not read
the Klook and KKday listing pages, so whether existing Okinawa rental shops connect this way is unknown.

**The shop** (T1, T4, T8)

7. Which OTAs does the shop actually want, and at what commission?
8. Is an OTA guest's balance paid at the shop or all online? The parked question is that the shop's own site says cash only.
9. Is the OTA cancellation policy the same as the web tiers? What cutoff do we publish?
10. How many OTA pickup times, and which? (T4)
11. Does the OTA get the web lead time and horizon (`min_lead_hours`, `max_days_ahead`)? (T4)
12. Is a net price or a commission rate kept in the sheet? Do we waive "site prices equal the sheet" for OTA retail? (T1)

**Vendors** (only if the fallback is taken)

13. Bokun: app price, whether a plan is also needed, one product per rental length, and multi-day resource holds.
14. Ventrata: can a shop be its own Supplier, does `octo/rentals` pass through a backend, and what is the minimum term?
15. Rakuten, Jalan and Asoview are absent from everything read, and they matter for a Japan shop. Is there any supplier
    connection? [Activityboard](https://activityboard.jp/) says it connects fully with Jalan, a lead not followed up.

## Phase-2 tickets

Not created on GitHub. Sizes are our estimate. T1 to T10 wait on T0.

| # | Ticket | Size | Depends on |
| --- | --- | --- | --- |
| T0 | Answer the gate questions with Klook and the shop (non-code) | S | |
| T1 | Sheet: OTA pickup times, net price or commission, mapped ids and connected channels; validation and docs | M | T0 |
| T2 | Migration: rebuild `bookings` with the OTA source, OTA reference index, net and retail columns | S | T0 |
| T3 | `createHold`: source, locale and expiry parameters, same insert | S | T2 |
| T4 | Availability for OCTO: vacancies by slot in one query, with a day-level cache | M | T1 |
| T5 | OCTO read side: auth, headers, errors, `/supplier`, `/products`, content, pricing | M | T1 |
| T6 | OCTO bookings: reserve, confirm, cancel, get, list, update, extend | M | T3, T4, T5 |
| T7 | Voucher with a QR or barcode, and the counter check | S | T6 |
| T8 | OTA reconciliation against the OTA's statement | M | T6, question 8 |
| T9 | Publish warning on Blocks rows for a connected channel, and the cutover | S | #21, T6 |
| T10 | OCTO validator and self-certification run, Klook test bookings, go live | S | T6, T7 |
| T11 | Only if the fallback is taken: Bokun Channel Manager plugin spike | M | T0 |

## What was not verified

Documentation only. There was no sandbox and no OTA or vendor was contacted. The OCTO validator was read, not run. The
Klook and KKday listing pages could not be read (they returned 403 or script only), so nothing here says how existing
shops are listed. Headout's help page was unread, so only the OCTO sheet's line is used for it. Research date: 2026-11-02; the OCTO sheet is titled "Updated: August 2026", and OCTO 2.0 is [in community
review](https://www.octo.travel/specification), so details may move.
