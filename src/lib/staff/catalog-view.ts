// What the staff panels of the Dashboard (#140) offer: the published models with their plates, the packages, the prices
// each model has through its rate class, and the pickup slots. Every model and vehicle is listed, inactive and retired
// ones too, with their flags, since a block may name any of them: the panels filter.
import type { PublishedCatalog } from "../db/catalog-store.ts";
import { pickupSlots } from "../booking/pickup-window.ts";
import type { ShopConfig, VehicleStatus, VehicleTypeId } from "../types.ts";

export type StaffModel = {
  id: string;
  nameJa: string;
  nameEn: string;
  typeId: VehicleTypeId;
  active: boolean;
  depositJpy: number;
  plates: { plate: string; status: VehicleStatus }[];
};

export type StaffPackage = { id: string; nameJa: string; nameEn: string; days: number | null; hours: number | null };

export type StaffPrice = { modelId: string; packageId: string; priceJpy: number; advancePriceJpy: number | null };

export type StaffCatalog = {
  ok: true;
  version: number;
  models: StaffModel[];
  packages: StaffPackage[];
  prices: StaffPrice[];
  slots: string[];
  config: Pick<ShopConfig, "shopOpen" | "shopClose" | "slotMinutes" | "minLeadHours" | "maxDaysAhead">;
};

function bySortThenId(a: { sort: number; id: string }, b: { sort: number; id: string }): number {
  return a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function staffCatalogView(catalog: PublishedCatalog): StaffCatalog {
  const depositOf = new Map(catalog.vehicleTypes.map((type) => [type.id, type.depositJpy]));
  const models = [...catalog.models].sort(bySortThenId);
  const packages = [...catalog.packages].sort(bySortThenId);
  const priceOf = new Map(catalog.prices.map((price) => [`${price.rateClassId}\n${price.packageId}`, price]));

  return {
    ok: true,
    version: catalog.version,
    models: models.map((model) => {
      const depositJpy = depositOf.get(model.typeId);
      // The publish checks every model's type, so a missing one is a broken catalog, not a deposit of 0.
      if (depositJpy === undefined) throw new Error(`model ${model.id} has no vehicle type ${model.typeId}`);
      const plates = catalog.vehicles
        .filter((vehicle) => vehicle.modelId === model.id)
        .map(({ plate, status }) => ({ plate, status }))
        .sort((a, b) => (a.plate < b.plate ? -1 : a.plate > b.plate ? 1 : 0));
      return {
        id: model.id,
        nameJa: model.texts.ja.name,
        nameEn: model.texts.en.name,
        typeId: model.typeId,
        active: model.active,
        depositJpy,
        plates,
      };
    }),
    packages: packages.map((pkg) => ({
      id: pkg.id,
      nameJa: pkg.texts.ja.name,
      nameEn: pkg.texts.en.name,
      days: pkg.days,
      hours: pkg.hours,
    })),
    prices: models.flatMap((model) =>
      packages.flatMap((pkg) => {
        const price = priceOf.get(`${model.rateClassId}\n${pkg.id}`);
        if (price === undefined) return [];
        return [{ modelId: model.id, packageId: pkg.id, priceJpy: price.priceJpy, advancePriceJpy: price.advancePriceJpy }];
      }),
    ),
    // No package: the Worker refuses a pickup an hours package does not return in hours from when the booking is made.
    slots: pickupSlots(catalog.config),
    config: {
      shopOpen: catalog.config.shopOpen,
      shopClose: catalog.config.shopClose,
      slotMinutes: catalog.config.slotMinutes,
      minLeadHours: catalog.config.minLeadHours,
      maxDaysAhead: catalog.config.maxDaysAhead,
    },
  };
}
