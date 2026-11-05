-- The demo catalog for hands-on testing, loaded by scripts/demo.sh. seed/local.sql stays the small sample.
--
-- Transcribed on 2026-11-02 from what https://okinawadream.my.canva.site shows:
--   every bike and car tile, the 9 bike classes and 3 car classes, the 4-hour, same-day and 24-hour bike prices, hourly
--   extensions, the 1 to 7 day car prices, the options table, seats per car class, and shop hours 09:00 to 17:00.
--   Prices include tax. A tile drawn twice in two colours is one model with two vehicles.
-- The e-bike rows (#130) come from the shop's e-bike flyer of 2026-11-04, which is not committed: the regular 1, 2 and 3 day
--   prices, the 4-hour and 24-hour prices on the bikes' hours packages, and the ¥500 helmet. Its 2-hour price waits for an
--   hours package of that length (#50), and its advance-booking price is a later ticket. The 1 day price sits on
--   bike-same-day and the 2 and 3 day prices on car-2d and car-3d, so the e-bike table reads in the flyer's order.
--
-- PLACEHOLDERS, which the site does not state and which the shop replaces:
--   the e-bike's deposit (0 until the shop says otherwise), its brand (TBC), its two vehicles and its photo.
--   deposit_jpy on every type, engine_cc on every car, the brand of the Nightster Special and Street Bob117 (their tiles
--   show unfilled template text), every plate, model summary wording and description, every config value other than
--   shop_open and shop_close, every refund tier, and every closed date (the site says it is open all year).
--   extension_per_hour_jpy is NULL on car classes because the site gives no car extension.
--
-- Loading it again is safe, also over existing bookings: rows bookings reference are updated in place, and models and
-- vehicles this file does not name end up inactive and retired, as a publish leaves them. A photos row is the file
-- seed/photos/<name>: after changing a file, update its md5, r2_key and bytes here. scripts/demo.sh reads these rows, so
-- keep each on one line.

DELETE FROM prices;
DELETE FROM packages;
DELETE FROM options;
DELETE FROM config;
DELETE FROM cancellation_tiers;
DELETE FROM closed_dates;
UPDATE models SET active = 0;
UPDATE vehicles SET status = 'retired';

-- PLACEHOLDER: deposit_jpy.
INSERT INTO vehicle_types (id, deposit_jpy, sort, texts) VALUES
  ('scooter', 1000, 1, '{"ja":{"name":"スクーター"},"en":{"name":"Scooter"},"zh-cn":{"name":"踏板车"},"ko":{"name":"스쿠터"}}'),
  ('motorcycle', 1000, 2, '{"ja":{"name":"バイク"},"en":{"name":"Motorcycle"},"zh-cn":{"name":"摩托车"},"ko":{"name":"오토바이"}}'),
  ('car', 1000, 3, '{"ja":{"name":"レンタカー"},"en":{"name":"Car"},"zh-cn":{"name":"汽车"},"ko":{"name":"자동차"}}'),
  ('ebike', 0, 4, '{"ja":{"name":"電動アシスト自転車"},"en":{"name":"E-bike"},"zh-cn":{"name":"电动助力自行车"},"ko":{"name":"전기자전거"}}')
ON CONFLICT (id) DO UPDATE SET deposit_jpy = excluded.deposit_jpy, sort = excluded.sort, texts = excluded.texts;

-- PLACEHOLDER: the car and e-bike classes' NULL extension. Neither the site nor the flyer states one.
INSERT INTO rate_classes (id, grp, sort, extension_per_hour_jpy, texts) VALUES
  ('r-50cc', 'bike', 1, 1000, '{"ja":{"name":"50cc原付"},"en":{"name":"50cc moped"},"zh-cn":{"name":"50cc轻便摩托车"},"ko":{"name":"50cc 원동기"}}'),
  ('r-110cc', 'bike', 2, 1000, '{"ja":{"name":"110cc"},"en":{"name":"110cc"},"zh-cn":{"name":"110cc"},"ko":{"name":"110cc"}}'),
  ('r-125cc', 'bike', 3, 1500, '{"ja":{"name":"125cc"},"en":{"name":"125cc"},"zh-cn":{"name":"125cc"},"ko":{"name":"125cc"}}'),
  ('r-160cc', 'bike', 4, 1500, '{"ja":{"name":"160cc"},"en":{"name":"160cc"},"zh-cn":{"name":"160cc"},"ko":{"name":"160cc"}}'),
  ('r-250cc', 'bike', 5, 2000, '{"ja":{"name":"250cc"},"en":{"name":"250cc"},"zh-cn":{"name":"250cc"},"ko":{"name":"250cc"}}'),
  ('r-350cc', 'bike', 6, 2500, '{"ja":{"name":"350cc"},"en":{"name":"350cc"},"zh-cn":{"name":"350cc"},"ko":{"name":"350cc"}}'),
  ('r-400cc', 'bike', 7, 3000, '{"ja":{"name":"400cc"},"en":{"name":"400cc"},"zh-cn":{"name":"400cc"},"ko":{"name":"400cc"}}'),
  ('r-over-400cc', 'bike', 8, 4000, '{"ja":{"name":"400cc以上"},"en":{"name":"Over 400cc"},"zh-cn":{"name":"400cc以上"},"ko":{"name":"400cc 이상"}}'),
  ('r-over-1000cc', 'bike', 9, 4000, '{"ja":{"name":"1000cc以上"},"en":{"name":"1000cc and over"},"zh-cn":{"name":"1000cc以上"},"ko":{"name":"1000cc 이상"}}'),
  ('r-k-car', 'car', 10, NULL, '{"ja":{"name":"K-Car"},"en":{"name":"K-Car"},"zh-cn":{"name":"K-Car（轻型车）"},"ko":{"name":"K-Car (경차)"}}'),
  ('r-standard', 'car', 11, NULL, '{"ja":{"name":"Standard"},"en":{"name":"Standard"},"zh-cn":{"name":"Standard（标准型）"},"ko":{"name":"Standard (일반형)"}}'),
  ('r-van', 'car', 12, NULL, '{"ja":{"name":"Van"},"en":{"name":"Van"},"zh-cn":{"name":"Van（厢式车）"},"ko":{"name":"Van (밴)"}}'),
  ('ebike', 'ebike', 13, NULL, '{"ja":{"name":"電動アシスト自転車"},"en":{"name":"E-bike"},"zh-cn":{"name":"电动助力自行车"},"ko":{"name":"전기자전거"}}')
ON CONFLICT (id) DO UPDATE SET grp = excluded.grp, sort = excluded.sort,
  extension_per_hour_jpy = excluded.extension_per_hour_jpy, texts = excluded.texts;

-- engine_cc and the rate class are the figures on each tile. PLACEHOLDER: engine_cc of the cars, and the Placeholder
-- brand rows. The FORZA250 tile really does say 160cc. The license class is the sheet default for the engine. The e-bike
-- has no engine, so its engine_cc is NULL and its license class none.
INSERT INTO models (id, type_id, engine_cc, license_class, sort, active, rate_class_id, brand, seats, texts, photos) VALUES
  ('yamaha-vino', 'scooter', 50, 'moped', 1, 1, 'r-50cc', 'Yamaha', NULL,
    '{"ja":{"name":"VINO","summary":"50ccのスクーター","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"VINO","summary":"50cc scooter","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"VINO","summary":"50cc踏板车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"VINO","summary":"50cc 스쿠터","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["yamaha-vino.jpg"]'),
  ('honda-dio110', 'scooter', 110, 'small', 2, 1, 'r-110cc', 'Honda', NULL,
    '{"ja":{"name":"DIO110","summary":"110ccのスクーター","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"DIO110","summary":"110cc scooter","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"DIO110","summary":"110cc踏板车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"DIO110","summary":"110cc 스쿠터","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-dio110.jpg"]'),
  ('yamaha-axisz125', 'scooter', 125, 'small', 3, 1, 'r-125cc', 'Yamaha', NULL,
    '{"ja":{"name":"AXISZ125","summary":"125ccのスクーター","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"AXISZ125","summary":"125cc scooter","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"AXISZ125","summary":"125cc踏板车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"AXISZ125","summary":"125cc 스쿠터","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["yamaha-axisz125.jpg"]'),
  ('honda-pcx125', 'scooter', 125, 'small', 4, 1, 'r-125cc', 'Honda', NULL,
    '{"ja":{"name":"PCX125","summary":"125ccのスクーター","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"PCX125","summary":"125cc scooter","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"PCX125","summary":"125cc踏板车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"PCX125","summary":"125cc 스쿠터","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-pcx125.jpg"]'),
  ('honda-cross-cub', 'motorcycle', 110, 'small', 5, 1, 'r-110cc', 'Honda', NULL,
    '{"ja":{"name":"CROSS CUB","summary":"110ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"CROSS CUB","summary":"110cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"CROSS CUB","summary":"110cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"CROSS CUB","summary":"110cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-cross-cub.jpg"]'),
  ('honda-hunter-cub-ct125', 'motorcycle', 125, 'small', 6, 1, 'r-125cc', 'Honda', NULL,
    '{"ja":{"name":"HUNTER CUB CT125","summary":"125ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"HUNTER CUB CT125","summary":"125cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"HUNTER CUB CT125","summary":"125cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"HUNTER CUB CT125","summary":"125cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-hunter-cub-ct125.jpg"]'),
  ('honda-dax125', 'motorcycle', 125, 'small', 7, 1, 'r-125cc', 'Honda', NULL,
    '{"ja":{"name":"DAX125","summary":"125ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"DAX125","summary":"125cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"DAX125","summary":"125cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"DAX125","summary":"125cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-dax125.jpg"]'),
  ('honda-monkey', 'motorcycle', 125, 'small', 8, 1, 'r-125cc', 'Honda', NULL,
    '{"ja":{"name":"Monkey","summary":"125ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Monkey","summary":"125cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Monkey","summary":"125cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Monkey","summary":"125cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-monkey.jpg"]'),
  ('honda-pcx160', 'scooter', 160, 'standard', 9, 1, 'r-160cc', 'Honda', NULL,
    '{"ja":{"name":"PCX160","summary":"160ccのスクーター","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"PCX160","summary":"160cc scooter","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"PCX160","summary":"160cc踏板车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"PCX160","summary":"160cc 스쿠터","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-pcx160.jpg"]'),
  ('honda-forza250', 'scooter', 160, 'standard', 10, 1, 'r-160cc', 'Honda', NULL,
    '{"ja":{"name":"FORZA250","summary":"160ccのスクーター","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"FORZA250","summary":"160cc scooter","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"FORZA250","summary":"160cc踏板车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"FORZA250","summary":"160cc 스쿠터","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-forza250.jpg"]'),
  ('suzuki-st250-wellington', 'motorcycle', 250, 'standard', 11, 1, 'r-250cc', 'Suzuki', NULL,
    '{"ja":{"name":"ST250 wellington","summary":"250ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"ST250 wellington","summary":"250cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"ST250 wellington","summary":"250cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"ST250 wellington","summary":"250cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["suzuki-st250-wellington.jpg"]'),
  ('honda-rebel250', 'motorcycle', 250, 'standard', 12, 1, 'r-250cc', 'Honda', NULL,
    '{"ja":{"name":"REBEL250","summary":"250ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"REBEL250","summary":"250cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"REBEL250","summary":"250cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"REBEL250","summary":"250cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-rebel250.jpg"]'),
  ('honda-rebel250-e-clutch', 'motorcycle', 250, 'standard', 13, 1, 'r-250cc', 'Honda', NULL,
    '{"ja":{"name":"REBEL250 -E Clutch","summary":"250ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"REBEL250 -E Clutch","summary":"250cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"REBEL250 -E Clutch","summary":"250cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"REBEL250 -E Clutch","summary":"250cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-rebel250-e-clutch.jpg"]'),
  ('suzuki-v-strom-250', 'motorcycle', 250, 'standard', 14, 1, 'r-250cc', 'Suzuki', NULL,
    '{"ja":{"name":"V-STROM 250","summary":"250ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"V-STROM 250","summary":"250cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"V-STROM 250","summary":"250cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"V-STROM 250","summary":"250cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["suzuki-v-strom-250.jpg"]'),
  ('honda-cbr250rr', 'motorcycle', 250, 'standard', 15, 1, 'r-250cc', 'Honda', NULL,
    '{"ja":{"name":"CBR250RR","summary":"250ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"CBR250RR","summary":"250cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"CBR250RR","summary":"250cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"CBR250RR","summary":"250cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-cbr250rr.jpg"]'),
  ('kawasaki-ninja400', 'motorcycle', 400, 'standard', 16, 1, 'r-400cc', 'Kawasaki', NULL,
    '{"ja":{"name":"NINJA400","summary":"400ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"NINJA400","summary":"400cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"NINJA400","summary":"400cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"NINJA400","summary":"400cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["kawasaki-ninja400.jpg"]'),
  ('honda-gb350', 'motorcycle', 350, 'standard', 17, 1, 'r-350cc', 'Honda', NULL,
    '{"ja":{"name":"GB350","summary":"350ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"GB350","summary":"350cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"GB350","summary":"350cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"GB350","summary":"350cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-gb350.jpg"]'),
  ('honda-cb400-sf-vtec-revo', 'motorcycle', 400, 'standard', 18, 1, 'r-400cc', 'Honda', NULL,
    '{"ja":{"name":"CB400 SF VTEC REVO","summary":"400ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"CB400 SF VTEC REVO","summary":"400cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"CB400 SF VTEC REVO","summary":"400cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"CB400 SF VTEC REVO","summary":"400cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-cb400-sf-vtec-revo.jpg"]'),
  ('honda-cb400-super-bol-dor', 'motorcycle', 400, 'standard', 19, 1, 'r-400cc', 'Honda', NULL,
    '{"ja":{"name":"CB400 SUPER BOL D''OR","summary":"400ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"CB400 SUPER BOL D''OR","summary":"400cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"CB400 SUPER BOL D''OR","summary":"400cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"CB400 SUPER BOL D''OR","summary":"400cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-cb400-super-bol-dor.jpg"]'),
  ('yamaha-xjr400r', 'motorcycle', 400, 'standard', 20, 1, 'r-400cc', 'Yamaha', NULL,
    '{"ja":{"name":"XJR400R","summary":"400ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"XJR400R","summary":"400cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"XJR400R","summary":"400cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"XJR400R","summary":"400cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["yamaha-xjr400r.jpg"]'),
  ('yamaha-xsr700', 'motorcycle', 700, 'large', 21, 1, 'r-over-400cc', 'Yamaha', NULL,
    '{"ja":{"name":"XSR700","summary":"700ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"XSR700","summary":"700cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"XSR700","summary":"700cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"XSR700","summary":"700cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["yamaha-xsr700.jpg"]'),
  ('kawasaki-z650rs', 'motorcycle', 650, 'large', 22, 1, 'r-over-400cc', 'Kawasaki', NULL,
    '{"ja":{"name":"Z650RS","summary":"650ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Z650RS","summary":"650cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Z650RS","summary":"650cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Z650RS","summary":"650cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["kawasaki-z650rs.jpg"]'),
  ('kawasaki-z900rs-cafe', 'motorcycle', 900, 'large', 23, 1, 'r-over-400cc', 'Kawasaki', NULL,
    '{"ja":{"name":"Z900RS Cafe","summary":"900ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Z900RS Cafe","summary":"900cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Z900RS Cafe","summary":"900cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Z900RS Cafe","summary":"900cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["kawasaki-z900rs-cafe.jpg"]'),
  ('nightster-special', 'motorcycle', 950, 'large', 24, 1, 'r-over-400cc', 'Placeholder brand', NULL,
    '{"ja":{"name":"Nightster Special","summary":"950ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Nightster Special","summary":"950cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Nightster Special","summary":"950cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Nightster Special","summary":"950cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["nightster-special.jpg"]'),
  ('street-bob117', 'motorcycle', 1900, 'large', 25, 1, 'r-over-1000cc', 'Placeholder brand', NULL,
    '{"ja":{"name":"Street Bob117","summary":"1900ccのバイク","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Street Bob117","summary":"1900cc motorcycle","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Street Bob117","summary":"1900cc摩托车","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Street Bob117","summary":"1900cc 오토바이","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["street-bob117.jpg"]'),
  ('honda-n-box', 'car', 1000, 'car', 26, 1, 'r-k-car', 'Honda', 4,
    '{"ja":{"name":"N-Box","summary":"K-Car、最大4名","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"N-Box","summary":"K-Car, up to 4 people","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"N-Box","summary":"K-Car，最多4人","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"N-Box","summary":"K-Car, 최대 4명","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["honda-n-box.jpg"]'),
  ('suzuki-hustler', 'car', 1000, 'car', 27, 1, 'r-k-car', 'Suzuki', 4,
    '{"ja":{"name":"Hustler","summary":"K-Car、最大4名","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Hustler","summary":"K-Car, up to 4 people","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Hustler","summary":"K-Car，最多4人","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Hustler","summary":"K-Car, 최대 4명","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["suzuki-hustler.jpg"]'),
  ('daihatsu-tanto', 'car', 1000, 'car', 28, 1, 'r-k-car', 'Daihatsu', 4,
    '{"ja":{"name":"Tanto","summary":"K-Car、最大4名","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Tanto","summary":"K-Car, up to 4 people","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Tanto","summary":"K-Car，最多4人","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Tanto","summary":"K-Car, 최대 4명","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["daihatsu-tanto.jpg"]'),
  ('toyota-roomy', 'car', 1000, 'car', 29, 1, 'r-standard', 'Toyota', 5,
    '{"ja":{"name":"Roomy","summary":"Standard、最大5名","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Roomy","summary":"Standard, up to 5 people","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Roomy","summary":"Standard，最多5人","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Roomy","summary":"Standard, 최대 5명","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["toyota-roomy.jpg"]'),
  ('mazda-cx-5', 'car', 1000, 'car', 30, 1, 'r-standard', 'Mazda', 5,
    '{"ja":{"name":"CX-5","summary":"Standard、最大5名","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"CX-5","summary":"Standard, up to 5 people","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"CX-5","summary":"Standard，最多5人","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"CX-5","summary":"Standard, 최대 5명","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["mazda-cx-5.jpg"]'),
  ('nissan-serena', 'car', 1000, 'car', 31, 1, 'r-van', 'Nissan', 8,
    '{"ja":{"name":"Serena","summary":"Van、最大8名","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"Serena","summary":"Van, up to 8 people","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"Serena","summary":"Van，最多8人","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"Serena","summary":"Van, 최대 8명","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["nissan-serena.jpg"]'),
  ('ebike-assist', 'ebike', NULL, 'none', 32, 1, 'ebike', 'TBC', NULL,
    '{"ja":{"name":"E-bike Assist","summary":"電動アシスト自転車、免許不要","description":"デモ用の仮の説明文です。お色や仕様が異なる場合がございます。"},"en":{"name":"E-bike Assist","summary":"Electric-assist bicycle, no license needed","description":"Placeholder description for the demo. Colour and specification may differ."},"zh-cn":{"name":"E-bike Assist","summary":"电动助力自行车，无需驾照","description":"演示用的占位说明。颜色和规格可能有所不同。"},"ko":{"name":"E-bike Assist","summary":"전기자전거, 면허 불필요","description":"데모용 임시 설명입니다. 색상과 사양은 다를 수 있습니다."}}',
    '["ebike-assist.jpg"]')
ON CONFLICT (id) DO UPDATE SET type_id = excluded.type_id, engine_cc = excluded.engine_cc,
  license_class = excluded.license_class, sort = excluded.sort, active = excluded.active,
  rate_class_id = excluded.rate_class_id, brand = excluded.brand, seats = excluded.seats, texts = excluded.texts,
  photos = excluded.photos;

-- PLACEHOLDER: the plates. One vehicle per tile on the site.
INSERT INTO vehicles (plate, model_id, status, odometer_km, base_usage_days) VALUES
  ('DEMO-001', 'yamaha-vino', 'active', NULL, 0),
  ('DEMO-002', 'honda-dio110', 'active', NULL, 0),
  ('DEMO-003', 'yamaha-axisz125', 'active', NULL, 0),
  ('DEMO-004', 'honda-pcx125', 'active', NULL, 0),
  ('DEMO-005', 'honda-cross-cub', 'active', NULL, 0),
  ('DEMO-006', 'honda-hunter-cub-ct125', 'active', NULL, 0),
  ('DEMO-007', 'honda-hunter-cub-ct125', 'active', NULL, 0),
  ('DEMO-008', 'honda-dax125', 'active', NULL, 0),
  ('DEMO-009', 'honda-dax125', 'active', NULL, 0),
  ('DEMO-010', 'honda-monkey', 'active', NULL, 0),
  ('DEMO-011', 'honda-pcx160', 'active', NULL, 0),
  ('DEMO-012', 'honda-forza250', 'active', NULL, 0),
  ('DEMO-013', 'suzuki-st250-wellington', 'active', NULL, 0),
  ('DEMO-014', 'honda-rebel250', 'active', NULL, 0),
  ('DEMO-015', 'honda-rebel250-e-clutch', 'active', NULL, 0),
  ('DEMO-016', 'suzuki-v-strom-250', 'active', NULL, 0),
  ('DEMO-017', 'honda-cbr250rr', 'active', NULL, 0),
  ('DEMO-018', 'kawasaki-ninja400', 'active', NULL, 0),
  ('DEMO-019', 'honda-gb350', 'active', NULL, 0),
  ('DEMO-020', 'honda-gb350', 'active', NULL, 0),
  ('DEMO-021', 'honda-cb400-sf-vtec-revo', 'active', NULL, 0),
  ('DEMO-022', 'honda-cb400-sf-vtec-revo', 'active', NULL, 0),
  ('DEMO-023', 'honda-cb400-super-bol-dor', 'active', NULL, 0),
  ('DEMO-024', 'yamaha-xjr400r', 'active', NULL, 0),
  ('DEMO-025', 'yamaha-xsr700', 'active', NULL, 0),
  ('DEMO-026', 'kawasaki-z650rs', 'active', NULL, 0),
  ('DEMO-027', 'kawasaki-z900rs-cafe', 'active', NULL, 0),
  ('DEMO-028', 'nightster-special', 'active', NULL, 0),
  ('DEMO-029', 'street-bob117', 'active', NULL, 0),
  ('DEMO-030', 'honda-n-box', 'active', NULL, 0),
  ('DEMO-031', 'suzuki-hustler', 'active', NULL, 0),
  ('DEMO-032', 'daihatsu-tanto', 'active', NULL, 0),
  ('DEMO-033', 'toyota-roomy', 'active', NULL, 0),
  ('DEMO-034', 'mazda-cx-5', 'active', NULL, 0),
  ('DEMO-035', 'nissan-serena', 'active', NULL, 0),
  ('DEMO-036', 'ebike-assist', 'active', NULL, 0),
  ('DEMO-037', 'ebike-assist', 'active', NULL, 0)
ON CONFLICT (plate) DO UPDATE SET model_id = excluded.model_id, status = excluded.status,
  odometer_km = excluded.odometer_km, base_usage_days = excluded.base_usage_days;

-- bike-same-day is days 1: data-model.md makes a one-day package the same-day rental, back by shop_close.
INSERT INTO packages (id, days, hours, sort, texts) VALUES
  ('bike-4h', NULL, 4, 1, '{"ja":{"name":"4時間"},"en":{"name":"4 hours"},"zh-cn":{"name":"4小时"},"ko":{"name":"4시간"}}'),
  ('bike-same-day', 1, NULL, 2, '{"ja":{"name":"当日（17時まで）"},"en":{"name":"Same day (until 17:00)"},"zh-cn":{"name":"当日（17点前）"},"ko":{"name":"당일 (17시까지)"}}'),
  ('bike-24h', NULL, 24, 3, '{"ja":{"name":"24時間"},"en":{"name":"24 hours"},"zh-cn":{"name":"24小时"},"ko":{"name":"24시간"}}'),
  ('car-1d', 1, NULL, 4, '{"ja":{"name":"1日"},"en":{"name":"1 day"},"zh-cn":{"name":"1天"},"ko":{"name":"1일"}}'),
  ('car-2d', 2, NULL, 5, '{"ja":{"name":"2日間"},"en":{"name":"2 days"},"zh-cn":{"name":"2天"},"ko":{"name":"2일"}}'),
  ('car-3d', 3, NULL, 6, '{"ja":{"name":"3日間"},"en":{"name":"3 days"},"zh-cn":{"name":"3天"},"ko":{"name":"3일"}}'),
  ('car-4d', 4, NULL, 7, '{"ja":{"name":"4日間"},"en":{"name":"4 days"},"zh-cn":{"name":"4天"},"ko":{"name":"4일"}}'),
  ('car-5d', 5, NULL, 8, '{"ja":{"name":"5日間"},"en":{"name":"5 days"},"zh-cn":{"name":"5天"},"ko":{"name":"5일"}}'),
  ('car-6d', 6, NULL, 9, '{"ja":{"name":"6日間"},"en":{"name":"6 days"},"zh-cn":{"name":"6天"},"ko":{"name":"6일"}}'),
  ('car-7d', 7, NULL, 10, '{"ja":{"name":"7日間"},"en":{"name":"7 days"},"zh-cn":{"name":"7天"},"ko":{"name":"7일"}}');

INSERT INTO prices (rate_class_id, package_id, price_jpy) VALUES
  ('r-50cc', 'bike-4h', 4000),
  ('r-50cc', 'bike-same-day', 5000),
  ('r-50cc', 'bike-24h', 6000),
  ('r-110cc', 'bike-4h', 6000),
  ('r-110cc', 'bike-same-day', 7000),
  ('r-110cc', 'bike-24h', 8000),
  ('r-125cc', 'bike-4h', 7000),
  ('r-125cc', 'bike-same-day', 8000),
  ('r-125cc', 'bike-24h', 9000),
  ('r-160cc', 'bike-4h', 8000),
  ('r-160cc', 'bike-same-day', 10000),
  ('r-160cc', 'bike-24h', 11000),
  ('r-250cc', 'bike-4h', 9000),
  ('r-250cc', 'bike-same-day', 11000),
  ('r-250cc', 'bike-24h', 13000),
  ('r-350cc', 'bike-4h', 11000),
  ('r-350cc', 'bike-same-day', 13000),
  ('r-350cc', 'bike-24h', 15000),
  ('r-400cc', 'bike-4h', 12000),
  ('r-400cc', 'bike-same-day', 15000),
  ('r-400cc', 'bike-24h', 17000),
  ('r-over-400cc', 'bike-4h', 15000),
  ('r-over-400cc', 'bike-same-day', 18000),
  ('r-over-400cc', 'bike-24h', 21000),
  ('r-over-1000cc', 'bike-4h', 18000),
  ('r-over-1000cc', 'bike-same-day', 22000),
  ('r-over-1000cc', 'bike-24h', 26000),
  ('r-k-car', 'car-1d', 6000),
  ('r-k-car', 'car-2d', 11000),
  ('r-k-car', 'car-3d', 15000),
  ('r-k-car', 'car-4d', 20000),
  ('r-k-car', 'car-5d', 25000),
  ('r-k-car', 'car-6d', 30000),
  ('r-k-car', 'car-7d', 35000),
  ('r-standard', 'car-1d', 8000),
  ('r-standard', 'car-2d', 15000),
  ('r-standard', 'car-3d', 21000),
  ('r-standard', 'car-4d', 28000),
  ('r-standard', 'car-5d', 35000),
  ('r-standard', 'car-6d', 42000),
  ('r-standard', 'car-7d', 49000),
  ('r-van', 'car-1d', 10000),
  ('r-van', 'car-2d', 19000),
  ('r-van', 'car-3d', 27000),
  ('r-van', 'car-4d', 36000),
  ('r-van', 'car-5d', 45000),
  ('r-van', 'car-6d', 54000),
  ('r-van', 'car-7d', 63000),
  ('ebike', 'bike-4h', 3500),
  ('ebike', 'bike-same-day', 4500),
  ('ebike', 'bike-24h', 5000),
  ('ebike', 'car-2d', 8000),
  ('ebike', 'car-3d', 10000);

-- base_jpy is the first 24 hours. A free option has no extra charges on the site.
INSERT INTO options (id, grp, sort, base_jpy, extra_per_hour_jpy, extra_per_24h_jpy, texts) VALUES
  ('opt-phone-holder', 'bike', 1, 0, NULL, NULL, '{"ja":{"name":"携帯ホルダー"},"en":{"name":"Phone holder"},"zh-cn":{"name":"手机支架"},"ko":{"name":"휴대폰 거치대"}}'),
  ('opt-half-helmet', 'bike', 2, 1000, 200, 500, '{"ja":{"name":"半ヘルメット"},"en":{"name":"Half helmet"},"zh-cn":{"name":"半盔"},"ko":{"name":"하프 헬멧"}}'),
  ('opt-full-face-helmet', 'bike', 3, 1500, 200, 500, '{"ja":{"name":"フルフェイス"},"en":{"name":"Full-face helmet"},"zh-cn":{"name":"全盔"},"ko":{"name":"풀페이스 헬멧"}}'),
  ('opt-gloves', 'bike', 4, 500, 200, 200, '{"ja":{"name":"グローブ"},"en":{"name":"Gloves"},"zh-cn":{"name":"手套"},"ko":{"name":"장갑"}}'),
  ('opt-intercom', 'bike', 5, 1000, 500, 500, '{"ja":{"name":"インカム"},"en":{"name":"Intercom"},"zh-cn":{"name":"对讲耳机"},"ko":{"name":"인터컴"}}'),
  ('opt-rainwear', 'bike', 6, 1000, 200, 500, '{"ja":{"name":"レインウエア"},"en":{"name":"Rainwear"},"zh-cn":{"name":"雨衣"},"ko":{"name":"우비"}}'),
  ('opt-bike-lock', 'bike', 7, 300, 100, 200, '{"ja":{"name":"車体ロック"},"en":{"name":"Bike lock"},"zh-cn":{"name":"车锁"},"ko":{"name":"바이크 잠금장치"}}'),
  ('opt-rubber-band', 'bike', 8, 200, 100, 200, '{"ja":{"name":"ゴムバンド"},"en":{"name":"Rubber band"},"zh-cn":{"name":"橡皮绑带"},"ko":{"name":"고무 밴드"}}'),
  ('opt-luggage-storage', 'bike', 9, 0, NULL, NULL, '{"ja":{"name":"荷物預かり"},"en":{"name":"Luggage storage"},"zh-cn":{"name":"行李寄存"},"ko":{"name":"짐 보관"}}'),
  ('opt-ebike-helmet', 'ebike', 10, 500, NULL, NULL, '{"ja":{"name":"自転車用ヘルメット"},"en":{"name":"Bicycle helmet"},"zh-cn":{"name":"自行车头盔"},"ko":{"name":"자전거 헬멧"}}');

-- shop_open and shop_close are the site's shop hours. PLACEHOLDER: the rest.
INSERT INTO config (key, value) VALUES
  ('shop_open', '09:00'),
  ('shop_close', '17:00'),
  ('slot_minutes', '30'),
  ('turnaround_minutes', '60'),
  ('hold_minutes', '15'),
  ('min_lead_hours', '24'),
  ('max_days_ahead', '180'),
  ('photo_max_mb', '5');

-- PLACEHOLDER: the site states no refund tiers.
INSERT INTO cancellation_tiers (min_days_before, refund_percent) VALUES
  (7, 100),
  (3, 50),
  (0, 0);

-- PLACEHOLDER: the site says open all year, so these exist only to test closed dates.
INSERT INTO closed_dates (date) VALUES
  ('2026-12-31'),
  ('2027-01-01'),
  ('2027-01-02');

-- One row per file in seed/photos. drive_file_id is a placeholder: these never came from Drive.
INSERT INTO photos (name, drive_file_id, md5, r2_key, content_type, bytes, copied_at) VALUES
  ('yamaha-vino.jpg', 'demo-seed', 'f5c558ee1dee9c34e2f67c28e6618509', 'photos/f5c558ee1dee9c34e2f67c28e6618509.jpg', 'image/jpeg', 8199, 1793577600000),
  ('honda-dio110.jpg', 'demo-seed', '0de5d1a5e272f4da15906ea3fbaf6945', 'photos/0de5d1a5e272f4da15906ea3fbaf6945.jpg', 'image/jpeg', 8260, 1793577600000),
  ('yamaha-axisz125.jpg', 'demo-seed', '459661393e8d0a1ce6c5260212c91275', 'photos/459661393e8d0a1ce6c5260212c91275.jpg', 'image/jpeg', 8948, 1793577600000),
  ('honda-pcx125.jpg', 'demo-seed', '88e3695b1bc9888fd3d15895c7b43d32', 'photos/88e3695b1bc9888fd3d15895c7b43d32.jpg', 'image/jpeg', 8245, 1793577600000),
  ('honda-cross-cub.jpg', 'demo-seed', '7277c57ea8633c06260e204857862d0e', 'photos/7277c57ea8633c06260e204857862d0e.jpg', 'image/jpeg', 9209, 1793577600000),
  ('honda-hunter-cub-ct125.jpg', 'demo-seed', 'df9630e9c022a449785540e1d52a4716', 'photos/df9630e9c022a449785540e1d52a4716.jpg', 'image/jpeg', 9803, 1793577600000),
  ('honda-dax125.jpg', 'demo-seed', '65c0ba78b5d12f1f22b8cc4c14519e42', 'photos/65c0ba78b5d12f1f22b8cc4c14519e42.jpg', 'image/jpeg', 7887, 1793577600000),
  ('honda-monkey.jpg', 'demo-seed', '0a2f9f71e05da6d0c0315f61c2bd7126', 'photos/0a2f9f71e05da6d0c0315f61c2bd7126.jpg', 'image/jpeg', 7611, 1793577600000),
  ('honda-pcx160.jpg', 'demo-seed', '24f0c01c0aae06b75bb67fef7cd76a74', 'photos/24f0c01c0aae06b75bb67fef7cd76a74.jpg', 'image/jpeg', 8204, 1793577600000),
  ('honda-forza250.jpg', 'demo-seed', '17721fe405e7916472960b92221fc274', 'photos/17721fe405e7916472960b92221fc274.jpg', 'image/jpeg', 9480, 1793577600000),
  ('suzuki-st250-wellington.jpg', 'demo-seed', '02f016a237243e3303699c423d53a4dd', 'photos/02f016a237243e3303699c423d53a4dd.jpg', 'image/jpeg', 9460, 1793577600000),
  ('honda-rebel250.jpg', 'demo-seed', '70cba15e9adb4c237a73530bd00dabf8', 'photos/70cba15e9adb4c237a73530bd00dabf8.jpg', 'image/jpeg', 8470, 1793577600000),
  ('honda-rebel250-e-clutch.jpg', 'demo-seed', '383ebc31840a16d33289ef06a322ef07', 'photos/383ebc31840a16d33289ef06a322ef07.jpg', 'image/jpeg', 9498, 1793577600000),
  ('suzuki-v-strom-250.jpg', 'demo-seed', 'daea5489f5c9e702135cce31380d8ee2', 'photos/daea5489f5c9e702135cce31380d8ee2.jpg', 'image/jpeg', 8521, 1793577600000),
  ('honda-cbr250rr.jpg', 'demo-seed', '658ecf3f4e133e5e69f2378efe3e71bd', 'photos/658ecf3f4e133e5e69f2378efe3e71bd.jpg', 'image/jpeg', 8917, 1793577600000),
  ('kawasaki-ninja400.jpg', 'demo-seed', 'aa0eb58b2d2bc2f604fdeb9cb68bb9a2', 'photos/aa0eb58b2d2bc2f604fdeb9cb68bb9a2.jpg', 'image/jpeg', 8485, 1793577600000),
  ('honda-gb350.jpg', 'demo-seed', '3394fa930427ff57c3ebb5c094ab885f', 'photos/3394fa930427ff57c3ebb5c094ab885f.jpg', 'image/jpeg', 7901, 1793577600000),
  ('honda-cb400-sf-vtec-revo.jpg', 'demo-seed', 'db2d6ea82168fc64f7fbf119c18407cc', 'photos/db2d6ea82168fc64f7fbf119c18407cc.jpg', 'image/jpeg', 10059, 1793577600000),
  ('honda-cb400-super-bol-dor.jpg', 'demo-seed', '4132b7691ba218a4dadc3632ac7926f0', 'photos/4132b7691ba218a4dadc3632ac7926f0.jpg', 'image/jpeg', 9109, 1793577600000),
  ('yamaha-xjr400r.jpg', 'demo-seed', '3f1fe2fbb14b0b3f9d36bc23a6832234', 'photos/3f1fe2fbb14b0b3f9d36bc23a6832234.jpg', 'image/jpeg', 8577, 1793577600000),
  ('yamaha-xsr700.jpg', 'demo-seed', '7d0b2825c1400f8940a661b4a61e0d13', 'photos/7d0b2825c1400f8940a661b4a61e0d13.jpg', 'image/jpeg', 8249, 1793577600000),
  ('kawasaki-z650rs.jpg', 'demo-seed', 'fa0d44cbf0003b133cff34cfab02273b', 'photos/fa0d44cbf0003b133cff34cfab02273b.jpg', 'image/jpeg', 8219, 1793577600000),
  ('kawasaki-z900rs-cafe.jpg', 'demo-seed', 'fdbd671156912b14c234e0320277dea6', 'photos/fdbd671156912b14c234e0320277dea6.jpg', 'image/jpeg', 8803, 1793577600000),
  ('nightster-special.jpg', 'demo-seed', 'c9c9a9e49d726bbccaf58fb50c725316', 'photos/c9c9a9e49d726bbccaf58fb50c725316.jpg', 'image/jpeg', 8445, 1793577600000),
  ('street-bob117.jpg', 'demo-seed', '1a6d035c9f93f0e495c22baa47513d99', 'photos/1a6d035c9f93f0e495c22baa47513d99.jpg', 'image/jpeg', 8704, 1793577600000),
  ('honda-n-box.jpg', 'demo-seed', 'b5f19678db68d601292364ff91d948f1', 'photos/b5f19678db68d601292364ff91d948f1.jpg', 'image/jpeg', 7831, 1793577600000),
  ('suzuki-hustler.jpg', 'demo-seed', '4dcefa3f0b1c60f5e18d975ba13a4786', 'photos/4dcefa3f0b1c60f5e18d975ba13a4786.jpg', 'image/jpeg', 7789, 1793577600000),
  ('daihatsu-tanto.jpg', 'demo-seed', '1649222278b3537a24caddcbb1655c74', 'photos/1649222278b3537a24caddcbb1655c74.jpg', 'image/jpeg', 7605, 1793577600000),
  ('toyota-roomy.jpg', 'demo-seed', '7fb68acbe68179dec3cde9043712e7e1', 'photos/7fb68acbe68179dec3cde9043712e7e1.jpg', 'image/jpeg', 7789, 1793577600000),
  ('mazda-cx-5.jpg', 'demo-seed', '751be8db58150fd7a4c53eaf21d590fa', 'photos/751be8db58150fd7a4c53eaf21d590fa.jpg', 'image/jpeg', 8223, 1793577600000),
  ('nissan-serena.jpg', 'demo-seed', 'b0b8fe692fa76b3b188674d1adf99633', 'photos/b0b8fe692fa76b3b188674d1adf99633.jpg', 'image/jpeg', 7911, 1793577600000),
  ('ebike-assist.jpg', 'demo-seed', '14823ceb850a4492de6e7e35c06db040', 'photos/14823ceb850a4492de6e7e35c06db040.jpg', 'image/jpeg', 11486, 1793577600000)
ON CONFLICT (name) DO UPDATE SET drive_file_id = excluded.drive_file_id, md5 = excluded.md5, r2_key = excluded.r2_key,
  content_type = excluded.content_type, bytes = excluded.bytes, copied_at = excluded.copied_at;

-- readCatalog returns null without this row. published_at is 2026-11-02T00:00:00Z.
INSERT INTO catalog_meta (id, version, published_at, source) VALUES (1, 1, 1793577600000, 'admin')
ON CONFLICT (id) DO UPDATE SET version = catalog_meta.version + 1, published_at = excluded.published_at,
  source = excluded.source;
