-- A small sample catalog for local dev, on a freshly migrated database:
--   npx wrangler d1 execute DB --local --file seed/local.sql
-- Invented data. Deposits and prices are placeholders, not the shop's. Later publishes replace all of it.

INSERT INTO vehicle_types (id, deposit_jpy, sort, texts) VALUES
  ('scooter', 1000, 1, '{"ja":{"name":"スクーター"},"en":{"name":"Scooter"},"zh-cn":{"name":"踏板车"},"ko":{"name":"스쿠터"}}'),
  ('motorcycle', 1000, 2, '{"ja":{"name":"バイク"},"en":{"name":"Motorcycle"},"zh-cn":{"name":"摩托车"},"ko":{"name":"오토바이"}}');

INSERT INTO rate_classes (id, grp, sort, extension_per_hour_jpy, texts) VALUES
  ('r-125cc', 'bike', 1, 1000, '{"ja":{"name":"125cc"},"en":{"name":"125cc"},"zh-cn":{"name":"125cc"},"ko":{"name":"125cc"}}'),
  ('r-400cc', 'bike', 2, 1500, '{"ja":{"name":"400cc"},"en":{"name":"400cc"},"zh-cn":{"name":"400cc"},"ko":{"name":"400cc"}}');

INSERT INTO models (id, type_id, engine_cc, license_class, sort, active, rate_class_id, brand, seats, texts, photos) VALUES
  ('pcx-125', 'scooter', 125, 'small', 1, 1, 'r-125cc', 'Honda', NULL,
    '{"ja":{"name":"PCX 125","summary":"街乗りに便利なスクーター","description":"サンプルの車両説明です。"},"en":{"name":"PCX 125","summary":"An easy scooter for town","description":"Sample vehicle description."},"zh-cn":{"name":"PCX 125","summary":"适合市区骑行的踏板车","description":"示例车辆说明。"},"ko":{"name":"PCX 125","summary":"시내 주행에 편한 스쿠터","description":"샘플 차량 설명입니다."}}',
    '[]'),
  ('address-125', 'scooter', 125, 'small', 2, 1, 'r-125cc', 'Suzuki', NULL,
    '{"ja":{"name":"Address 125","summary":"軽くて扱いやすいスクーター","description":"サンプルの車両説明です。"},"en":{"name":"Address 125","summary":"A light, simple scooter","description":"Sample vehicle description."},"zh-cn":{"name":"Address 125","summary":"轻便易骑的踏板车","description":"示例车辆说明。"},"ko":{"name":"Address 125","summary":"가볍고 다루기 쉬운 스쿠터","description":"샘플 차량 설명입니다."}}',
    '[]'),
  ('ninja-400', 'motorcycle', 399, 'standard', 3, 1, 'r-400cc', 'Kawasaki', NULL,
    '{"ja":{"name":"Ninja 400","summary":"ツーリング向けのバイク","description":"サンプルの車両説明です。"},"en":{"name":"Ninja 400","summary":"A motorcycle for touring","description":"Sample vehicle description."},"zh-cn":{"name":"Ninja 400","summary":"适合长途骑行的摩托车","description":"示例车辆说明。"},"ko":{"name":"Ninja 400","summary":"투어링에 알맞은 오토바이","description":"샘플 차량 설명입니다."}}',
    '[]');

INSERT INTO vehicles (plate, model_id, status, odometer_km, base_usage_days) VALUES
  ('OKI-101', 'pcx-125', 'active', 1200, 0),
  ('OKI-102', 'pcx-125', 'active', 3400, 0),
  ('OKI-103', 'address-125', 'active', 800, 0),
  ('OKI-401', 'ninja-400', 'active', 5600, 0),
  ('OKI-402', 'ninja-400', 'active', NULL, 0);

INSERT INTO packages (id, days, hours, sort, texts) VALUES
  ('one-day', 1, NULL, 1, '{"ja":{"name":"1日"},"en":{"name":"One day"},"zh-cn":{"name":"1天"},"ko":{"name":"1일"}}'),
  ('three-days', 3, NULL, 2, '{"ja":{"name":"3日"},"en":{"name":"Three days"},"zh-cn":{"name":"3天"},"ko":{"name":"3일"}}'),
  ('one-week', 7, NULL, 3, '{"ja":{"name":"1週間"},"en":{"name":"One week"},"zh-cn":{"name":"1周"},"ko":{"name":"1주일"}}');

INSERT INTO prices (rate_class_id, package_id, price_jpy) VALUES
  ('r-125cc', 'one-day', 4000),
  ('r-125cc', 'three-days', 10000),
  ('r-125cc', 'one-week', 20000),
  ('r-400cc', 'one-day', 8000),
  ('r-400cc', 'three-days', 20000),
  ('r-400cc', 'one-week', 40000);

INSERT INTO config (key, value) VALUES
  ('shop_open', '09:00'),
  ('shop_close', '18:00'),
  ('slot_minutes', '30'),
  ('turnaround_minutes', '60'),
  ('hold_minutes', '15'),
  ('min_lead_hours', '24'),
  ('max_days_ahead', '180'),
  ('photo_max_mb', '5');

INSERT INTO cancellation_tiers (min_days_before, refund_percent) VALUES
  (7, 100),
  (3, 50),
  (0, 0);

-- readCatalog returns null without this row. published_at is 2026-01-01T00:00:00Z.
INSERT INTO catalog_meta (id, version, published_at, source) VALUES (1, 1, 1767225600000, 'admin');
