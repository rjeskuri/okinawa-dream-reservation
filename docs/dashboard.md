# Staff dashboard

The Dashboard in the Google Sheet runs the four main staff jobs as step-by-step windows, with no typing in the tabs: add
a bike, cancel a booking, add a phone or walk-in reservation, and block a bike. This guide is for staff and the owner.
[docs/sheet-schema.md](sheet-schema.md) says what each tab and column holds. The code is in `apps-script/`.

## Open it

- Use Google Sheets in a computer browser. The Sheets apps on phones and tablets do not show the Okinawa Dream menu, the
  sidebar or the windows.
- Okinawa Dream > Open dashboard shows the home in a sidebar, with one button per action. The four actions are also on
  the Okinawa Dream menu, and can be buttons on the Dashboard tab ([Setup](#setup)).
- Only people who can edit the sheet see the Okinawa Dream menu.
- Each action opens a window of numbered steps with Back and Next. Next checks the step before it moves on. The last step
  shows the result and has no Back or Next, so an action cannot be sent twice. Close the window and open the action again
  for the next one.
- While the window waits for an answer it shows Working… and its buttons are off. A problem shows in a red box at the
  top of the window.
- When the home lists WORKER_BASE_URL or PUBLISH_SECRET, the dashboard cannot reach the website until the owner sets them
  ([Setup](#setup)).

## Messages any action can show

The actions ask the website through requests signed with PUBLISH_SECRET.

| Message | Meaning |
| --- | --- |
| `Set WORKER_BASE_URL and PUBLISH_SECRET in Project Settings, under Script Properties.` | One of them is not set. Nothing was sent. |
| `The request failed: the Worker answered 401: {"error":"unauthorized"}` | PUBLISH_SECRET in Script Properties is not the website's, or the website's clock is more than 5 minutes off. Nothing was done. |
| `The request failed: the Worker answered 500: Publishing is not set up on the Worker, ...` | The website has no PUBLISH_SECRET. Nothing was done. |
| `The request failed:` with another code, a web page or a network error | The request may not have reached the website. Check that WORKER_BASE_URL is the website's address and the website is up. Locally the tunnel's address changes on every run. |
| `... the Worker sent a response that could not be read` | WORKER_BASE_URL points at something that is not the website. |

A request that failed with no answer may still have done its work. Before trying again, search for the booking in
Cancel a booking, or press Create reservation again in Add a reservation, which cannot book twice.

## Add a bike

Adds a bike of a model already in Models, or a new model with the rows it needs, then publishes. It only adds rows: it
never changes or deletes a row already in the sheet.

1. **New or existing.** A bike of a model already in Models, or a bike of a new model. The window reads Models, Vehicles,
   Types, RateClasses, Prices and Packages from this sheet, not from the website, so a model not yet published is offered
   too.
2. **Model.** For an existing model, pick it from the list. For a new one: the model id, such as `pcx-125`; the type; the
   brand; the engine in cc, none for an e-bike; and optionally seats, a license class (blank takes the default for the
   type and engine) and the sort (blank goes last). A model id already in Models is flagged here, and the check makes it
   an error.
3. **Photos**, optional. Choose a JPEG, PNG or WebP and press Upload this photo. It goes into the website's photo folder
   in Drive at once, named `<model id>-<n>.jpg`, `.png` or `.webp` with the first free n, and the window lists that name.
   Save adds the names to the model's `photos` cell, after any already there. Changing the model after an upload drops
   that photo from the bike, and the file stays in Drive, used by no model. For an existing model, Next goes on to
   step 8.
4. **Rate class.** Only the classes of the group the type fits: `ebike` for an e-bike, `car` for a car, `bike` for a
   scooter or motorcycle. Or a new class of that group: its id, an optional sort and extension per hour, and its name in
   four languages.
5. **Prices.** A new class takes a price per package, with an optional advance price. A package left blank is not
   offered, and at least one price is needed. A class already in the sheet shows its prices read-only: every model of the
   class shares them, so change them in Prices.
6. **Deposit.** A type with a Types row shows its deposit read-only: change it in Types. A type with no row takes a
   deposit, an optional sort and its name in four languages.
7. **Translations.** The model's name, summary and description in Japanese, English, Chinese and Korean, as guests read
   them. A blank summary or description is a warning, not an error.
8. **Vehicle.** The plate, flagged when Vehicles already has it, and optionally the odometer, base usage days and notes.
   Notes are not published. Next asks the website to check the rows.
9. **Check.** Each row the save would add, with `ok`, `warning` or `error` and the messages a Publish would give: see
   [publish_status](sheet-schema.md#publish_status). A reason above the rows, such as a bad Config value, stops every
   Publish: fix it in its tab. With any error, Save and publish refuses. Go Back, fix the step, and press Next on step 8
   to check again.
10. **Result.** Each row written, as `<tab> row <n>: publish_status <status>`, then the Publish messages.

Save and publish checks the rows again, then adds each below the last row of its tab, under the headers by name:

- Types: a row only when the type had none, with the deposit, sort and names.
- RateClasses and Prices: only for a new class, with one Prices row per package priced.
- Models: the new model, `active` TRUE, with its photos. For an existing model, only the names added to its `photos` cell.
- Vehicles: the bike, `status` `active`.

It then runs a full Publish, the same as Publish to website, logged in PublishLog, so any other change waiting in the
tabs goes live too. The Publish copies the new photos to the website.

| Message | Meaning |
| --- | --- |
| `The check found a problem, so nothing was saved.` | The sheet changed after the check. The window shows the new check. |
| `A Publish is running, so nothing was saved. ...` | Try again when it has finished. |
| `Could not write the row, so nothing was published: ...` | The save stopped partway. Below the check, the window lists each row it had already written as `<tab> row <n>`; for a model already in Models, its row is listed because this save added photos to its `photos` cell. Delete those rows (or take those photos out of the cell) before saving again, or keep them, add the rest in the tabs and use Publish to website. With no list, nothing was written. |
| `Publish stopped, the site is unchanged` or `Publish failed: ...` in the result | The rows are in the sheet. Fix the cause, then use Publish to website. Do not run Add a bike again, which would add the rows twice. |
| `Photos with errors: ...` in the result | The copy to the website refused the named photo, for the reason given. |
| `Only a JPEG, PNG or WebP photo can be uploaded. ...` | Save the image as one of those first. |
| `The photo is ... bytes, over the ... that photo_max_mb in Config allows.` | Make the photo smaller. |
| `Could not add the photo to the photo folder: ...` | Usually view-only access to the folder: the owner gives you edit access. |
| `Set PHOTO_FOLDER_ID ...` or `Could not open the photo folder set in PHOTO_FOLDER_ID: ...` | The owner's [setup](#setup). |
| `Another photo is uploading. Try again in a moment.` | Two uploads at once. |

## Cancel a booking

Cancels a confirmed booking made on the website or with Add a reservation, and refunds what staff choose through Square.

1. **Find the booking.** A whole ref, or part of the guest's family or given name, or both names in either order. Add the
   pickup date in Japan, or search by the date alone. With both blank the next bookings are listed. The list holds at
   most 20, earliest pickup first, of confirmed bookings that have not ended: no holds, no cancelled bookings, no blocks.
2. **Pick the booking.** Show the refund asks the website what each choice gives.
3. **Choose the refund.** The window shows what was paid online and anything already refunded. Each amount below is less
   what the booking has already had back, and never below 0.
   - Tier refund: what the guest's own cancel link gives, the percent of the published cancellation tiers at the number of
     days before the pickup date, in Japan. On or after the pickup date it is the tier for 0 days.
   - Full refund: all that is left of what was paid online.
   - No refund.

   The choice starts on the tier refund, and on no refund once the pickup time has passed, such as for a no-show. When
   nothing can go back, the only choice is to cancel.
4. **Confirm.** The guest, ref, pickup, choice and the amount going back through Square. Money moves only on Confirm.
5. **Result.**

Confirm cancels the booking, which frees the bike, records the refund staff chose, and sends that refund to Square. The
website emails the guest and the shop, and updates the booking's row on the Bookings tab shortly. The window writes
nothing to the sheet itself.

| Result | Meaning |
| --- | --- |
| `The booking is cancelled. No refund goes back through Square.` | No refund was chosen, or there was nothing to refund. |
| `... Square accepted the refund of ... and is completing it.` or `... Square has refunded ...` | Done. |
| `... Square has not taken the refund of ... yet: the website sends it again on its own.` | Square gave no final answer. The website tries again every ten minutes under the same key, so the guest cannot be refunded twice. |
| `The booking is cancelled, but Square rejected the refund of .... ...` | The booking stays cancelled and the shop gets an alert email. Settle the refund with the guest in the Square Dashboard. |

Refusals, where nothing was cancelled:

- `The refund amounts changed since the quote, ...`: a refund landed, or the day moved the booking into another tier,
  after the window asked. The window goes back to the choices with the new amounts: choose and confirm again.
- `This booking is already cancelled, ...`: staff or the guest cancelled it already.
- `The website has no booking with this id. ...` or `The website cannot cancel this booking: ...`: search again.

### The refund choice and the daily check

The daily check runs at 03:00 Japan time. It compares the website's bookings with Square over the last 35 days, rewrites
the Reconciliation tab, and emails the shop when it finds an issue. For a booking staff cancelled, it expects the shop to
keep what was paid less the refund staff chose, whichever of the three it was, not the tier. So a full refund or no
refund is no issue once Square has settled it.

- A `retained_mismatch` whose detail starts `Cancelled by staff with` means the chosen refund has not gone through:
  Square rejected it, or it was still waiting at the time of the check. One still waiting clears on a later run once it
  is done.
- A refund made by hand in the Square Dashboard shows once as `refund_not_recorded`, is recorded, and counts from then on.
- A guest's own cancellation is checked against the tier on the day they cancelled.

## Add a reservation

Books a phone or walk-in guest who pays at the shop. The website picks the bike and sends the emails.

1. **Guest.** Family name, given name and phone are required. The email is optional: with none, the guest gets no email.
   The language is that of the guest's emails.
2. **Model.** From the website's published catalog, not the sheet: active models with an active bike and a price. A model
   not yet published is not offered.
3. **Package**, with its price, and the advance price where the class has one.
4. **Pickup**, date and time in Japan. Dates run from today to `max_days_ahead` days ahead. Times are the pickup slots,
   and for an hours package only those it comes back from within shop hours.
5. **Check and create.** Everything entered, the price, and the deposit to collect at the shop. Create reservation books
   it.
6. **Booked.** The ref, the plate the website took, pickup and return, the price, and `Collect the deposit of ... at the
   shop.` New reservation starts an empty form.

The website takes the least-used free bike of the model, by the same rule as a web booking, so it cannot double-book. The
booking is confirmed at once, with source `staff`, nothing paid online, and the type's deposit to collect at the shop.
The price is the website's: the advance price when booked before the pickup date in Japan, as for a web booking. The
website emails the guest the confirmation when there is an email, emails the shop, and adds the booking to the Bookings
tab shortly. The guest's details go only to the website: the window writes nothing to the sheet itself.

Every pickup rule of a web booking applies except the lead time (owner decision 1): a pickup is too soon only once its
slot has ended, so a walk-in can take the slot that has begun.

When Create reservation fails and the message does not say why, press it again. The form keeps its id, so a second press
answers the booking the first one made, if it made one, and never books twice. New reservation takes a new id.

| Message | What to do |
| --- | --- |
| `Every bike of this model is booked or blocked ...` | Choose another time, date, package or model. |
| A pickup outside shop hours, off the slots, on a closed day, coming back outside hours or on a closed day, a slot that has ended, or too far ahead | Choose as the message says. |
| `The website did not take the guest's details: ...` | The window goes back to the Guest step with the fields marked. |
| `The website has no bookable model ...`, `... no package ...` or `... no price ...` | The catalog changed: close the window and open it again. |
| `This form's id already belongs to a different booking, ...` | An earlier try booked other details. Look for the guest on the Bookings tab, then open a new form. |
| `The catalog is not published yet. ...` or `No model can be booked: ...` | Publish first, with an active model that has an active bike and a price. |

### Bookings paid at the shop

- Nothing is paid online. The deposit is collected in person at pickup, and the website keeps no record of it.
- The guest's confirmation email shows the deposit to pay at the shop, says cancelling refunds nothing, and keeps a
  cancel link, so the guest can free the bike without calling.
- The cancel link says nothing was paid online, so cancelling refunds nothing, and cancels without Square. Like any
  cancel link it closes at pickup. The guest, when there is an email, and the shop get the cancellation email.
- Cancel a booking offers one choice for these, to cancel with nothing to refund, and never calls Square. Money taken at
  the counter is settled at the counter.
- The daily check leaves them out: no missing payment and no refund check.

## Block a bike

Takes a bike out of service for a while, for maintenance, through a row on the Blocks tab.

1. **Which bike.** A model, a plate, or both. Every published model and bike is listed, marked when a model is not on
   the site or a bike is in maintenance or retired. A plate sets its model. Any bike of the model lets the website take
   the least-used bike that is free.
2. **When.** Start and end in Japan time. The end must be after the start.
3. **Reason**, kept in the row's `note`.
4. **Check and save.** Save and sync.
5. **Result.**

Save and sync adds one row at the bottom of Blocks: a new `block_id` from the time of saving, such as
`MNT-20270715-0900-a1b2`, the model, the plate or blank for any bike, `start` and `end` as `YYYY-MM-DD HH:mm`, `channel`
`maintenance`, and the reason in `note`. It then runs the blocks step of Publish only, which syncs every Blocks row as
Publish does, and adds a PublishLog row naming the block. The catalog is not published.

| Result | Meaning |
| --- | --- |
| `Saved MNT-... on Blocks row .... The website has it: the bike is blocked.` | Done. |
| `... The website did not take it: Conflicts with ... on .... ...` | A booking, by its ref, or another block, by its `block_id`, holds that bike for part of the time. With any bike, `No vehicle of ... is free`. See below. |
| `... The sync failed: ...` or `... The sync stopped with ... rows still to do. ...` | The row is saved, and the next Publish syncs it. |

A row the website did not take stays on the tab with the error. Each Publish tries it again and blocks the bike once the
time is free, so delete the row if you do not want that. To block that bike anyway, move the booking to another bike
with `override_plate` on the Bookings tab, then Publish.

Refused before anything is written: a start or end that is not a real date and time, an end not after the start, a
model or plate not in the published catalog, a plate of another model, and `A Publish is running. ...`.

### End or change a block

Maintenance blocks live on the Blocks tab, beside the OTA blocks: see [Blocks](sheet-schema.md#blocks). To end one early,
delete its row and press Publish to website: the block is cancelled and the bike is free again. To change its times, edit
`start` or `end` and Publish. Never change a `block_id`. A block that has ended is never changed.

A delete cancels nothing while the tab has a row with a blank `block_id`, or when it leaves the tab with no data rows
while blocks that have not ended are stored. Keep one row on the tab, such as a block that has ended.

## What the dashboard cannot do

- Change or delete what is already in the sheet: a model's details, a bike's status such as maintenance or retired, an
  existing class's prices or a type's deposit. Add a bike only adds rows, always an active model and an active bike.
  Edit the tab and Publish.
- Packages, options, refund tiers, closed dates and Config: edit those tabs.
- Take a photo off a model, or out of Drive: edit the model's `photos` cell and the folder.
- Move a booking to another bike: use `override_plate` on the Bookings tab.
- Change a booking's dates, package or guest details.
- Refund any amount but the three choices, or refund without cancelling.
- Cancel a hold, a booking whose payment is under way, or a booking that has ended.
- Cancel an OTA block, or change or end a maintenance block: use the Blocks tab.
- Take a card payment for a phone booking, or record a deposit collected at the shop.
- List more than 20 bookings for one search: search more narrowly.
- Record in the sheet who made a reservation or a cancellation. Publish, Add a bike and Block a bike log the user in
  PublishLog.
- Run in the Sheets apps on a phone or tablet.

## Setup

For the owner, once per sheet.

1. **Code.** Put the files of `apps-script/` into the sheet's Apps Script project (Extensions > Apps Script), and the
   scopes of `apps-script/appsscript.json` into its manifest. A manifest holding more than the repo's, such as a
   `webapp` section, keeps it: add the scopes, do not copy the file over it.
   [docs/local-dev.md](local-dev.md#staff-dashboard) does this for the test sheet.
2. **Script Properties.** In Extensions > Apps Script > Project Settings > Script Properties:
   - `WORKER_BASE_URL`: the website's address, such as `https://<domain>`, with no path. Locally the tunnel's address,
     which changes on every run.
   - `PUBLISH_SECRET`: the same value as the website's secret of that name. It signs Publish and every dashboard request,
     so it also lets its holder make reservations and cancel and refund bookings (owner decision 5).
   - `PHOTO_FOLDER_ID`: the id of the photo folder the website copies photos from, the same as `GOOGLE_DRIVE_FOLDER_ID`
     ([docs/deploy.md](deploy.md#photo-upload-from-add-a-bike)).

   Type the values only into Project Settings: never into a cell, a document, a chat, an email or a commit. The home
   lists WORKER_BASE_URL and PUBLISH_SECRET when either is missing. A missing PHOTO_FOLDER_ID shows only at an upload.
3. **Drive access.** The manifest asks for `https://www.googleapis.com/auth/drive.file` so that Add a bike can upload
   photos. Once it is in, each staff member re-authorizes the script at the first menu item they run: allow it. Each
   staff member who uploads photos needs edit access to the photo folder. If the live check shows `drive.file` cannot
   write into the folder, the fallback in docs/deploy.md applies, and everyone re-authorizes once more.
4. **Set up tabs.** Okinawa Dream > Set up tabs creates the Dashboard tab, with how to open the dashboard and each
   action's function, and any other missing tab. Tabs already there stay as they are, a Dashboard tab too. It also sets
   the sheet's time zone to Asia/Tokyo.
5. **Buttons on the Dashboard tab**, optional. Apps Script cannot put buttons on a tab, but a drawing can run a function.
   Choose Insert > Drawing, draw a shape with a label, and Save and close. On the drawing's three-dot menu choose Assign
   script and enter `openAddBike`, `openCancelBooking`, `openAddReservation` or `openBlockBike`, with no brackets.
   Clicking the drawing opens that action, in a computer browser only.
