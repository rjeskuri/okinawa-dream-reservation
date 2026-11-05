-- The catalog, bookings and their bookkeeping, shaped on OCTO: docs/data-model.md explains it.
-- Times are INTEGER epoch ms UTC and money is INTEGER JPY. A texts column is JSON keyed by locale.
-- Models and vehicles are never deleted, because bookings reference them.
-- The test helper splits statements on a semicolon at the end of a line, so triggers cannot live here.

-- The catalog: one row, written by each publish.
CREATE TABLE catalog_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('sheet','admin'))
) STRICT;

CREATE TABLE vehicle_types (
  id TEXT PRIMARY KEY CHECK (id IN ('scooter','motorcycle','car','ebike')),
  deposit_jpy INTEGER NOT NULL CHECK (deposit_jpy >= 0),
  sort INTEGER NOT NULL,
  texts TEXT NOT NULL
) STRICT;

-- The rows of the shop's fee schedule, for example 125cc or K-Car.
CREATE TABLE rate_classes (
  id TEXT PRIMARY KEY,
  grp TEXT NOT NULL CHECK (grp IN ('bike','car','ebike')),
  sort INTEGER NOT NULL,
  extension_per_hour_jpy INTEGER CHECK (extension_per_hour_jpy >= 0),
  texts TEXT NOT NULL
) STRICT;

-- Models carry no prices: a model inherits them from its rate class. photos is a JSON array of Drive file names.
-- An e-bike has no engine and needs no license: engine_cc may be NULL and license_class none only on type ebike.
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL REFERENCES vehicle_types(id),
  engine_cc INTEGER CHECK (engine_cc > 0),
  license_class TEXT NOT NULL CHECK (license_class IN ('moped','small','standard','large','car','none')),
  sort INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  rate_class_id TEXT NOT NULL REFERENCES rate_classes(id),
  brand TEXT NOT NULL,
  seats INTEGER CHECK (seats > 0),
  texts TEXT NOT NULL,
  photos TEXT NOT NULL,
  CHECK (engine_cc IS NOT NULL OR type_id = 'ebike'),
  CHECK (license_class <> 'none' OR type_id = 'ebike')
) STRICT;

CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  days INTEGER CHECK (days BETWEEN 1 AND 60),
  hours INTEGER CHECK (hours BETWEEN 1 AND 72),
  sort INTEGER NOT NULL,
  texts TEXT NOT NULL,
  CHECK ((days IS NULL) <> (hours IS NULL))
) STRICT;

CREATE TABLE prices (
  rate_class_id TEXT NOT NULL REFERENCES rate_classes(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  price_jpy INTEGER NOT NULL CHECK (price_jpy > 0),
  PRIMARY KEY (rate_class_id, package_id)
) STRICT;

-- Priced extras shown on the fee schedule. Choosing them while booking is out of scope.
CREATE TABLE options (
  id TEXT PRIMARY KEY,
  grp TEXT NOT NULL CHECK (grp IN ('bike','car','ebike')),
  sort INTEGER NOT NULL,
  base_jpy INTEGER NOT NULL CHECK (base_jpy >= 0),
  extra_per_hour_jpy INTEGER CHECK (extra_per_hour_jpy >= 0),
  extra_per_24h_jpy INTEGER CHECK (extra_per_24h_jpy >= 0),
  texts TEXT NOT NULL
) STRICT;

CREATE TABLE vehicles (
  plate TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id),
  status TEXT NOT NULL CHECK (status IN ('active','maintenance','retired')),
  odometer_km INTEGER,
  base_usage_days INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE cancellation_tiers (
  min_days_before INTEGER PRIMARY KEY CHECK (min_days_before >= 0),
  refund_percent INTEGER NOT NULL CHECK (refund_percent BETWEEN 0 AND 100)
) STRICT;

CREATE TABLE closed_dates (
  date TEXT PRIMARY KEY
) STRICT;

-- package_id is deliberately not a foreign key: a package can leave the catalog while bookings of it remain.
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ON_HOLD','PAYMENT_PENDING','CONFIRMED','CANCELLED','EXPIRED')),
  source TEXT NOT NULL CHECK (source IN ('web','block')),
  model_id TEXT NOT NULL REFERENCES models(id),
  package_id TEXT,
  vehicle_plate TEXT NOT NULL REFERENCES vehicles(plate),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  expires_at INTEGER,
  price_jpy INTEGER CHECK (price_jpy >= 0),
  deposit_jpy INTEGER CHECK (deposit_jpy >= 0),
  catalog_version INTEGER,
  locale TEXT,
  guest_family_name TEXT,
  guest_given_name TEXT,
  guest_email TEXT,
  guest_phone TEXT,
  external_ref TEXT,
  external_channel TEXT,
  content_hash TEXT,
  payment_id TEXT,
  payment_attempt INTEGER NOT NULL DEFAULT 0,
  paid_jpy INTEGER NOT NULL DEFAULT 0 CHECK (paid_jpy >= 0),
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  CHECK (end_at > start_at)
) STRICT;

CREATE INDEX idx_bookings_vehicle_start ON bookings (vehicle_plate, start_at);

CREATE INDEX idx_bookings_status_expires ON bookings (status, expires_at);

CREATE INDEX idx_bookings_payment ON bookings (payment_id);

CREATE UNIQUE INDEX idx_bookings_block_external_ref ON bookings (external_ref) WHERE source = 'block';

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  square_refund_id TEXT UNIQUE,
  amount_jpy INTEGER NOT NULL CHECK (amount_jpy > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','REJECTED','FAILED','RETRY')),
  origin TEXT NOT NULL CHECK (origin IN ('cancel','dashboard')),
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('email','sheet_booking')),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claimed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE photos (
  name TEXT PRIMARY KEY,
  drive_file_id TEXT NOT NULL,
  md5 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  copied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE kv_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
