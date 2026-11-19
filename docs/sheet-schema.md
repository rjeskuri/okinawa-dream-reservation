# Sheet schema

Staff run inventory, prices, packages, deposits, refund tiers and shop settings in one Google Sheet. This page lists
every tab, what each column accepts, and what `publish_status` tells you after a Publish. The checks are in
`src/lib/catalog/sheet-schema.ts`, and `SHEET_TABS` there is the source of the headers.

Every value in the examples is a placeholder, not a real price, deposit or plate.

## Tabs at a glance

| Tab | Who edits it | Read by |
| --- | --- | --- |
| Config, Types, Models, Vehicles, RateClasses, Packages, Prices, Options, Cancellation, ClosedDates | Staff | Publish replaces the site's catalog from these ten tabs. |
| Blocks | Staff | The blocks step of Publish. |
| Bookings | The Worker, except `override_plate` | Staff, and the assignments step of Publish. |
| Reconciliation | The Worker | Staff. |
| PublishLog | The Apps Script | Staff. |

## Rules for every tab

- **Headers.** Every column listed on this page must exist, also where the cell may stay empty. A header matches by name
  in any column order, and upper or lower case and spaces around it do not matter. Extra columns are ignored, so you can
  keep your own notes in one.
- **Text.** Spaces around a value are removed, also the wide space of a Japanese keyboard. In every column that is
  checked or matched (ids, numbers, money, dates, times, TRUE/FALSE, statuses, brand and notes), full-width characters
  become half-width and half-width katakana become full-width (Unicode NFKC) before the check. `ｐｃｘ－１２５` and
  `pcx-125` are the same id. The exceptions are the texts guests read, which are kept as typed: see Translations.
  The `photos` column is kept exact too.
- **Ids (slugs).** Lower-case letters, digits and single hyphens, at most 40 characters: `pcx-125`. Not `PCX_125`, not
  `pcx--125`, not `-pcx`.
- **Allowed values** are written exactly as shown, in lower case.
- **Money.** Whole yen. `5000`, `5,000`, `¥5,000` and `5000円` all read as 5000.
- **Whole numbers.** Digits only, with no decimals. `sort`, `odometer_km` and `base_usage_days` are 0 or more.
- **TRUE/FALSE.** A checkbox, or the text `TRUE` or `FALSE`.
- **Dates.** A date cell, or text as `2027-07-15`.
- **Date and time.** A date-time cell, or text as `2027-07-15 09:00`. Times are Japan time.
- **Plausible dates.** In ClosedDates and Blocks, a date more than 2 years before or after the publish date (Japan time)
  is refused with a row status and the row is skipped. This catches a date typed as digits, such as `260105`, which
  Sheets reads as a day number in the year 2612.
- **Times of day.** A time cell, or text as `09:00`.
- **A number in a text column** is fine: plate `2002` is the text `2002`.
- **Repeats.** Where an id must be unique, the first row owns it and each later row gets an error, even if the first row
  itself has an error.
- **Blank rows** are ignored and get no status. An unticked checkbox alone counts as blank. Rows below keep their real
  row numbers.

## Translations

Columns ending `_ja`, `_en`, `_zh` and `_ko` hold the text of each site language; `_zh` is the site's `zh-cn`. A blank
cell gets a warning and shows the English text, or the Japanese text if English is blank too, or else any language the
row has. A row with no name in any language is an error. Summaries and descriptions may be blank in every language: the
row still publishes, with a warning per cell.

The `name_`, `summary_` and `description_` columns are published exactly as typed, with only the spaces around the text
removed. Full-width punctuation such as `，` and `！` and characters such as `①` stay as they are, and so does
half-width katakana. A cell of only spaces counts as blank.

## publish_status

Every tab from Config to Blocks ends with a `publish_status` column, which the tables below leave out. The Worker
rewrites it on each Publish and ignores whatever is in it, so do not type there.

| Shows | Meaning |
| --- | --- |
| `ok` | The row is published. |
| A warning | The row is published, but check it: for example a missing translation. |
| An error | The row is **not** published. The message names the column and the problem. |

A row can have several messages.

A Prices row with an error of its own is the one exception: the site keeps the price it already has for that rate class
and package, so the package stays bookable. The row is still an error, and its message ends with the price kept, for
example `error: price_jpy -5 must be a whole number of at least 1; the site keeps the last published price 4,000`. See
[Prices](#prices).

A bad row also skips the rows that depend on it, and each of those gets its own error. Fix the first row and the others
clear on the next Publish.

| When this row is skipped | These are skipped too |
| --- | --- |
| Types | The models of that type, and their vehicles. |
| RateClasses | The models of that class, their vehicles, and the prices of that class. |
| Packages | The prices of that package. |
| Models | The vehicles of that model. |

Some problems stop the whole Publish. Nothing changes on the site, nothing is written to the sheet, and the reasons
appear in the alert the Publish menu shows:

- a required tab or a header is missing;
- a Config key is missing, or its value is bad.

What the code does today: `validateCatalog` returns no catalog and lists each reason, for example
`Config: slot_minutes is missing or invalid`. Writing nothing back and showing the alert belong to the Publish endpoint
(task #15) and the Apps Script menu (task #16), which are not built yet.

## Config

One setting per row. All eight keys are required. A bad or missing value is fatal: the Publish stops, nothing is
written back to the sheet (also not to the other rows), and the reason, such as `Config: shop_close is missing or
invalid`, appears in the Publish alert. Staff see only that short reason. The check also words a longer message for the
row (for `08:00` as `shop_close`: `shop_close 08:00 must be after shop_open 09:00`), but on a fatal Publish it is shown
nowhere: not in the alert, and not in `publish_status`, which is not written. Check the value against the table below.

| Column | Accepts |
| --- | --- |
| `key` | A key below. Any other key gets a warning and is ignored. |
| `value` | As below. |

| key | value | Example |
| --- | --- | --- |
| `shop_open` | Time of day | `09:00` |
| `shop_close` | Time of day, after `shop_open`; if it is not, the Publish stops with `Config: shop_close is missing or invalid`. | `18:00` |
| `slot_minutes` | Whole number, 1 or more | `30` |
| `turnaround_minutes` | Whole number, 0 or more | `60` |
| `hold_minutes` | Whole number, 1 or more | `15` |
| `min_lead_hours` | Whole number, 0 or more | `24` |
| `max_days_ahead` | Whole number, 0 or more | `180` |
| `photo_max_mb` | Whole number, 1 or more | `5` |

## Types

| Column | Required | Accepts |
| --- | --- | --- |
| `type_id` | Yes | `scooter`, `motorcycle`, `car` or `ebike` (an electric-assist bicycle). One row each. |
| `deposit_jpy` | Yes | Money, 0 or more |
| `sort` | Yes | Whole number |
| `name_ja`, `name_en`, `name_zh`, `name_ko` | At least one | Text |

Example: `motorcycle`, `5,000`, `2`, `バイク`, `Motorcycle`, `摩托车`, `오토바이`.

## RateClasses

| Column | Required | Accepts |
| --- | --- | --- |
| `rate_class_id` | Yes | Slug, unique |
| `group` | Yes | `bike`, `car` or `ebike`: the table of the fee schedule the class shows in |
| `sort` | Yes | Whole number |
| `extension_per_hour_jpy` | No | Money, 0 or more |
| `name_ja`, `name_en`, `name_zh`, `name_ko` | At least one | Text |

Example: `bike-125`, `bike`, `2`, `700`, `125cc`, `125cc bike`, `125cc摩托车`, `125cc 오토바이`. An e-bike class is in group
`ebike`: `ebike`, `ebike`, `13`, blank, `電動アシスト自転車`, `E-bike`, `电动助力自行车`, `전기자전거`.

Nothing checks that a model's type matches its class's group, so price an e-bike in an `ebike` class yourself, or it
shows under Bikes or Cars on the fee schedule.

## Packages

| Column | Required | Accepts |
| --- | --- | --- |
| `package_id` | Yes | Slug, unique |
| `days` | Exactly one of these two | Whole number, 1 to 60 |
| `hours` | Exactly one of these two | Whole number, 1 to 72 |
| `sort` | Yes | Whole number |
| `name_ja`, `name_en`, `name_zh`, `name_ko` | At least one | Text |

Examples: `day-3`, `3`, blank, `3`, `3日`, `3 days`, `3天`, `3일`. And `hours-6`, blank, `6`, `1`, `6時間`, `6 hours`,
`6小时`, `6시간`.

## Prices

One row per rate class and package. A model takes the prices of its rate class, so adding a model or a vehicle needs no
new rows here. Prices include tax.

| Column | Required | Accepts |
| --- | --- | --- |
| `rate_class_id` | Yes | An id from RateClasses |
| `package_id` | Yes | An id from Packages |
| `price_jpy` | Yes | Money, 1 or more |
| `advance_price_jpy` | No | Blank for none, or money from 1 up to the row's own `price_jpy` |

Example: `bike-125`, `day-1`, `¥5,200`, blank.

`advance_price_jpy` is the price for booking ahead: a guest who books by 23:59 Japan time the day before the pickup date
pays it, and a booking on the pickup date pays `price_jpy`. A blank cell means the row has one price for everyone. A
value above `price_jpy` is an error, not a cap, because the two columns are most likely swapped: the row is skipped, as
is a zero or text. The price is fixed when the guest's hold is made, so a publish after that does not change it.

Example: `ebike`, `day-1`, `4500`, `4000`: ¥4,000 when booked by the day before, ¥4,500 on the day.

A row with an error in `price_jpy` or `advance_price_jpy`, a blank `price_jpy` too, keeps the last published price: the
site goes on using the `price_jpy` and `advance_price_jpy` it already has for that rate class and package, both as they
were, never mixed with the row's new values. The row stays an error until it is fixed, and its message names what the
site uses, for example `the site keeps the last published price 5,200 and advance price 4,800`. The next Publish with a
good row replaces the kept price with the sheet's. A row that never published has no price to keep: it is skipped and
its message says the package is not bookable for that rate class.

The rule covers only a row's own errors. A row whose rate class or package is skipped loses its price, as the table
under [publish_status](#publish_status) says. Deleting a row, or clearing all its cells, removes its price. A repeat of
an earlier row's rate class and package is an error that changes nothing: the first row decides the price.

## Models

| Column | Required | Accepts |
| --- | --- | --- |
| `model_id` | Yes | Slug, unique |
| `type_id` | Yes | An id from Types |
| `rate_class_id` | Yes | An id from RateClasses |
| `brand` | Yes | Text |
| `seats` | No | Whole number, 1 or more |
| `engine_cc` | Yes, except on an e-bike | Whole number, 1 or more. Blank on type `ebike`: a number there is an error. |
| `license_class` | No | Blank uses the default below, or an override: `moped`, `small`, `standard`, `large`, `car` or `none` |
| `sort` | Yes | Whole number |
| `active` | Yes | TRUE/FALSE |
| `name_ja`, `name_en`, `name_zh`, `name_ko` | At least one | Text |
| `summary_ja`, `summary_en`, `summary_zh`, `summary_ko` | No | Text |
| `description_ja`, `description_en`, `description_zh`, `description_ko` | No | Text |
| `photos` | No | Drive file names separated by any of three commas, `,`, `，` or `、`: `pcx-1.jpg, pcx-2.jpg` or `pcx-1.jpg、pcx-2.jpg`. Names are kept exactly as typed, with only the spaces around each one removed. |

The default license class comes from the type and the engine:

| Engine | Class |
| --- | --- |
| Up to 50 cc | `moped` |
| 51 to 125 cc | `small` |
| 126 to 400 cc | `standard` |
| Over 400 cc | `large` |
| Type `car`, any engine | `car` |
| Type `ebike`, no engine | `none`: no license needed |

An override on a scooter or motorcycle replaces the default. `moped` is allowed only up to 125 cc, and `car` is an error.
On a car the class stays `car` and on an e-bike `none`: another of the six classes gets a warning and is ignored.
`none` on any type but `ebike` is an error, a car included, and so is anything outside the six on any type.

An e-bike leaves `engine_cc` blank. A number there, even a valid one, is an error and the model is skipped with its
vehicles: staff most likely picked the wrong `type_id`.

Example: `cub-110`, `motorcycle`, `bike-125`, `Honda`, `1`, `110`, `moped`, `3`, `TRUE`, then the texts, then
`cub-1.jpg`.

## Vehicles

| Column | Required | Accepts |
| --- | --- | --- |
| `plate` | Yes | Text, unique |
| `model_id` | Yes | An id from Models |
| `status` | Yes | `active`, `maintenance` or `retired` |
| `odometer_km` | No | Whole number |
| `base_usage_days` | No | Whole number. Blank is 0. |
| `notes` | No | Text. Not published. |

Example: `わ1234`, `pcx-125`, `active`, `8000`, `30`, `Scratch on the left mirror`.

## Options

| Column | Required | Accepts |
| --- | --- | --- |
| `option_id` | Yes | Slug, unique |
| `group` | Yes | `bike`, `car` or `ebike` |
| `base_jpy` | Yes | Money, 0 or more |
| `extra_per_hour_jpy` | No | Money, 0 or more |
| `extra_per_24h_jpy` | No | Money, 0 or more |
| `sort` | Yes | Whole number |
| `name_ja`, `name_en`, `name_zh`, `name_ko` | At least one | Text |

Example: `child-seat`, `car`, `1,100`, `110`, `550`, `2`, `チャイルドシート`, `Child seat`, `儿童座椅`, `카시트`. And an
e-bike's helmet: `ebike-helmet`, `ebike`, `500`, blank, blank, `3`, `自転車用ヘルメット`, `Bicycle helmet`, `自行车头盔`,
`자전거 헬멧`.

## Cancellation

One row per refund tier.

| Column | Required | Accepts |
| --- | --- | --- |
| `min_days_before` | Yes | Whole number, unique |
| `refund_percent` | Yes | Whole number, 0 to 100 |

Example: `7`, `100`.

## ClosedDates

| Column | Required | Accepts |
| --- | --- | --- |
| `date` | Yes | A date, unique. A date cell and the same date as text count as the same date. |
| `note` | No | Text. Not published. |

Example: `2027-01-01`, `New Year`.

A date more than 2 years before or after the publish date is an error: the row is skipped and the date is not closed.

## Blocks

One row per booking taken elsewhere, such as an OTA or a walk-in. A block holds a vehicle like a booking does. It is
checked against the published catalog, so publish a new model before blocking it. A block may name an inactive model, or
a plate in maintenance or retired.

| Column | Required | Accepts |
| --- | --- | --- |
| `block_id` | Yes | Text, unique. Do not reuse or change the id of a block. |
| `model_id` | Yes | An id from Models |
| `plate` | No | A plate of that model. Blank lets the site choose. |
| `start` | Yes | Date and time |
| `end` | Yes | Date and time, after `start` |
| `channel` | No | Text, such as `Klook` |
| `reference` | No | Text, the booking number on that channel |
| `note` | No | Text |

Example: `BLK-1`, `pcx-125`, blank, `2027-07-15 09:00`, `2027-07-16 18:00`, `Klook`, `KL-1234`, `Group of two`.

A missing Blocks tab, a tab with no header row (as when its contents were cleared), or a missing header stops the blocks
step: stored blocks stay as they are, nothing is cancelled, and nothing is written to the tab. A row with an error does
not change the block already stored under its id, so fix the row and press Publish again. That includes a `start` or
`end` more than 2 years before or after the publish date: the row is skipped, its status names the column, and the block
stored under that id stays as it is.

Each Publish then brings the stored blocks in line with the tab, and `publish_status` says what became of each row:

- **A new row** takes the plate it names, or with a blank plate the least-used free vehicle of the model. A named plate
  is the only vehicle it can take, even when others are free.
- **A changed row** keeps its vehicle if that is free for the new times. With a blank plate it otherwise moves to the
  least-used free vehicle, as it does when its vehicle is now in maintenance or retired. A change to `channel`,
  `reference` or `note` alone moves nothing.
- **A block moved with `override_plate`** on the Bookings tab stays on that bike when its row's `channel`, `reference`
  or `note` changes. A new `plate` moves it to that plate. New times on a row that names a plate ask for that plate
  again, and with a blank plate the block keeps the bike staff chose if it is free.
- **A row that cannot get a vehicle** shows an error naming what is in the way, a booking's ref or a block's `block_id`,
  and the plate. No new block is stored, and a stored block stays exactly as it was until a Publish finds the times free.
- **A row deleted from the tab** cancels its block, unless the block has ended. Ended blocks are never changed: a later
  edit to one shows a warning. A row put back later takes its block back, if the times are still free.
- **A row that shows it was not synced yet** was past the limit of one Publish, which works through 200 changes. Press
  Publish again.

Two blocks on one named plate cannot swap times in one Publish, because each is in the other's way: both rows show an
error. Move one to a free time, Publish, and then set the times you want.

Two mistakes cancel nothing, so that they cannot free a bike an OTA has sold:

- **A row with a blank `block_id`.** It may be the row of any stored block, so no block is cancelled while the tab has
  one. Creates and edits still run, and when a block would otherwise have been cancelled, the alert says so. Fill in the
  id and press Publish again.
- **A tab with its header but no data rows**, while blocks that have not ended are stored. The alert reports an error.
  To cancel every block on purpose, keep one row on the tab, such as a block that has ended, while removing the others.

## Bookings

The Worker writes this tab. **Use filter views, and never sort it**: a sort moves rows, and one that lands while the
Worker is updating the tab can put a booking's update on the wrong row. A filter view moves nothing.

Every column up to the last one needs a header, because a column with no header stops the Worker writing to this tab
until it is named or removed.

Staff type in one column, `override_plate`, to move a booking to another bike. Publish moves it if that bike is active,
of the same model and free for the booking's time. `override_status` then shows the result, and the booking keeps its
bike if the move was refused.

Only a confirmed booking that has not ended can move. A plate that already matches the booking is left alone, with no
result, so an old override can stay on the row. One Publish moves at most 20 bookings: a row past that says so in
`override_status`, and the next Publish applies it. Rows run top to bottom, so when two rows want one bike for
overlapping times, the higher row gets it.

If Publish fails on writing to this tab, the moves it made still stand, and publishing again finds nothing to do for
those rows. Each move is queued for the Worker's own update of the tab, which writes its `plate`. That update leaves
`override_status` alone, so the cell stays as it was.

| Column | Holds |
| --- | --- |
| `booking_ref`, `booking_id` | The booking's reference and internal id |
| `status`, `source` | The booking's status, and `web`, `block` or `staff` |
| `model_id`, `plate` | The model and the assigned vehicle |
| `override_plate` | **Staff:** the plate to move the booking to |
| `override_status` | The result of the last override |
| `start`, `end` | When the rental starts and ends |
| `package_id` | The package booked |
| `guest_name`, `guest_email`, `guest_phone`, `locale` | The guest and their language |
| `price_jpy`, `deposit_jpy`, `paid_jpy` | The price, the deposit and what has been paid |
| `refund_jpy`, `refund_status` | The refund and how far it has got |
| `created_at`, `updated_at` | When the booking was created and last changed |

## Reconciliation

The daily check of bookings against Square and this sheet rewrites the tab on each run, with the run time, the counts
and one row per issue. Do not edit it.

| Column | Holds |
| --- | --- |
| `run_at` | When the check ran |
| `counts` | What the check counted |
| `type` | The kind of issue |
| `booking_ref`, `payment_id`, `refund_id` | What the issue is about, where it applies |
| `expected_jpy`, `actual_jpy` | The two amounts that disagree, where it applies |
| `detail` | The issue in words |

## PublishLog

The Apps Script adds one row per Publish: `time`, `user`, `version`, `counts`, `blocks`, `photos`, `assignments`,
`message`. Do not edit it.

## Keep the sheet in Japan time

Keep the spreadsheet's time zone at **Asia/Tokyo** (File, then Settings). The site reads every date and time cell as
Japan time, so under another setting anything the sheet or the Apps Script stamps with the current time is off by the
difference.
