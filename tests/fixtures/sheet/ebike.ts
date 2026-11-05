// An e-bike added to the valid sheet fixture (#130): a Types row, a rate class in group ebike with three prices, one model
// with a blank engine_cc and license_class, two active bicycles and a helmet option. addEbike writes the rows as staff type
// them; withEbike adds the same rows to a catalog as they must publish, written out by hand and never read from the code.
// The prices are the flyer's (1 day ¥4,500, 3 days ¥10,000), with ¥2,500 on the fixture's 6-hour package.
import type { Catalog, Model, Option, Price, RateClass, Vehicle, VehicleType } from "../../../src/lib/types.ts";
import { appendRow, type Workbook } from "../../helpers/sheet-workbook.ts";

export const EBIKE_TYPE = "ebike";
export const EBIKE_CLASS = "ebike-std";
export const EBIKE_MODEL = "assist-26";
export const EBIKE_PLATES = ["わ2001", "わ2002"];
export const EBIKE_OPTION = "ebike-helmet";

/** The e-bike class's price of each fixture package. */
export const EBIKE_PRICES: Record<string, number> = { "hours-6": 2500, "day-1": 4500, "day-3": 10000 };

const TYPE_NAMES = { ja: "電動アシスト自転車", en: "E-bike", "zh-cn": "电动助力自行车", ko: "전기자전거" };
const CLASS_NAMES = { ja: "電動アシスト", en: "E-bike", "zh-cn": "电动助力车", ko: "전기 자전거" };
const OPTION_NAMES = { ja: "自転車用ヘルメット", en: "Bicycle helmet", "zh-cn": "自行车头盔", ko: "자전거 헬멧" };
const MODEL_TEXTS = {
  ja: { name: "アシスト26", summary: "26インチの電動アシスト", description: "坂道も楽に走れます。" },
  en: { name: "Assist 26", summary: "26-inch electric assist", description: "Hills feel flat." },
  "zh-cn": { name: "助力26", summary: "26英寸电动助力", description: "上坡也轻松。" },
  ko: { name: "어시스트26", summary: "26인치 전기 어시스트", description: "언덕도 편하게 달립니다." },
};

/** The sheet columns of a name in each locale: zh-cn is written `_zh`. */
function nameCells(names: Record<"ja" | "en" | "zh-cn" | "ko", string>, field = "name"): Record<string, string> {
  return {
    [`${field}_ja`]: names.ja,
    [`${field}_en`]: names.en,
    [`${field}_zh`]: names["zh-cn"],
    [`${field}_ko`]: names.ko,
  };
}

/** The e-bike's Models row, `changes` over its cells. engine_cc and license_class are left blank. */
export function ebikeModelCells(changes: Record<string, unknown> = {}): Record<string, unknown> {
  const field = (name: "name" | "summary" | "description") =>
    nameCells(
      {
        ja: MODEL_TEXTS.ja[name],
        en: MODEL_TEXTS.en[name],
        "zh-cn": MODEL_TEXTS["zh-cn"][name],
        ko: MODEL_TEXTS.ko[name],
      },
      name,
    );
  return {
    model_id: EBIKE_MODEL,
    type_id: EBIKE_TYPE,
    rate_class_id: EBIKE_CLASS,
    brand: "Panasonic",
    seats: "",
    engine_cc: "",
    license_class: "",
    sort: 6,
    active: true,
    ...field("name"),
    ...field("summary"),
    ...field("description"),
    photos: "assist-1.jpg, assist-2.jpg",
    ...changes,
  };
}

/** Appends the e-bike's rows below the fixture's, with `model` over the cells of its Models row. */
export function addEbike(workbook: Workbook, model: Record<string, unknown> = {}): void {
  appendRow(workbook, "Types", { type_id: EBIKE_TYPE, deposit_jpy: 0, sort: 4, ...nameCells(TYPE_NAMES) });
  appendRow(workbook, "RateClasses", {
    rate_class_id: EBIKE_CLASS,
    group: "ebike",
    sort: 5,
    extension_per_hour_jpy: 500,
    ...nameCells(CLASS_NAMES),
  });
  for (const [packageId, price] of Object.entries(EBIKE_PRICES)) {
    appendRow(workbook, "Prices", { rate_class_id: EBIKE_CLASS, package_id: packageId, price_jpy: price });
  }
  appendRow(workbook, "Models", ebikeModelCells(model));
  for (const plate of EBIKE_PLATES) appendRow(workbook, "Vehicles", { plate, model_id: EBIKE_MODEL, status: "active" });
  appendRow(workbook, "Options", {
    option_id: EBIKE_OPTION,
    group: "ebike",
    base_jpy: 500,
    sort: 3,
    ...nameCells(OPTION_NAMES),
  });
}

const localized = <T>(texts: Record<"ja" | "en" | "zh-cn" | "ko", T>) => texts;

export const EBIKE_VEHICLE_TYPE: VehicleType = {
  id: "ebike",
  depositJpy: 0,
  sort: 4,
  texts: localized({
    ja: { name: TYPE_NAMES.ja },
    en: { name: TYPE_NAMES.en },
    "zh-cn": { name: TYPE_NAMES["zh-cn"] },
    ko: { name: TYPE_NAMES.ko },
  }),
};

export const EBIKE_RATE_CLASS: RateClass = {
  id: EBIKE_CLASS,
  grp: "ebike",
  sort: 5,
  extensionPerHourJpy: 500,
  texts: localized({
    ja: { name: CLASS_NAMES.ja },
    en: { name: CLASS_NAMES.en },
    "zh-cn": { name: CLASS_NAMES["zh-cn"] },
    ko: { name: CLASS_NAMES.ko },
  }),
};

/** The model as it publishes: no engine, and the license class every e-bike has. */
export const EBIKE_MODEL_ROW: Model = {
  id: EBIKE_MODEL,
  typeId: "ebike",
  engineCc: null,
  licenseClass: "none",
  sort: 6,
  active: true,
  rateClassId: EBIKE_CLASS,
  brand: "Panasonic",
  seats: null,
  texts: MODEL_TEXTS,
  photos: ["assist-1.jpg", "assist-2.jpg"],
};

export const EBIKE_VEHICLES: Vehicle[] = EBIKE_PLATES.map((plate) => ({
  plate,
  modelId: EBIKE_MODEL,
  status: "active",
  odometerKm: null,
  baseUsageDays: 0,
}));

export const EBIKE_OPTION_ROW: Option = {
  id: EBIKE_OPTION,
  grp: "ebike",
  sort: 3,
  baseJpy: 500,
  extraPerHourJpy: null,
  extraPer24hJpy: null,
  texts: localized({
    ja: { name: OPTION_NAMES.ja },
    en: { name: OPTION_NAMES.en },
    "zh-cn": { name: OPTION_NAMES["zh-cn"] },
    ko: { name: OPTION_NAMES.ko },
  }),
};

export const EBIKE_PRICE_ROWS: Price[] = Object.entries(EBIKE_PRICES).map(([packageId, priceJpy]) => ({
  rateClassId: EBIKE_CLASS,
  packageId,
  priceJpy,
}));

/** `catalog` with everything addEbike appends, as it must publish. */
export function withEbike(catalog: Catalog): Catalog {
  return {
    ...catalog,
    vehicleTypes: [...catalog.vehicleTypes, structuredClone(EBIKE_VEHICLE_TYPE)],
    rateClasses: [...catalog.rateClasses, structuredClone(EBIKE_RATE_CLASS)],
    prices: [...catalog.prices, ...structuredClone(EBIKE_PRICE_ROWS)],
    models: [...catalog.models, structuredClone(EBIKE_MODEL_ROW)],
    vehicles: [...catalog.vehicles, ...structuredClone(EBIKE_VEHICLES)],
    options: [...catalog.options, structuredClone(EBIKE_OPTION_ROW)],
  };
}
