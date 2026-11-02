// Test data for the photo copy: the smallest catalog whose models name photos, and the bytes of a fake photo. The bytes
// are not valid images, which nothing here reads, and they are not valid UTF-8, so a copy that goes through text shows.
import { createHash } from "node:crypto";
import { LOCALES } from "../../src/lib/locale.ts";
import type { Catalog, LocalizedTexts } from "../../src/lib/types.ts";

export type PhotoModel = { id: string; photos: string[]; active?: boolean };

function texts<T>(fields: T): LocalizedTexts<T> {
  return Object.fromEntries(LOCALES.map((locale) => [locale, fields])) as LocalizedTexts<T>;
}

/** A catalog holding `models` and only what they need. */
export function photoCatalog(models: PhotoModel[], photoMaxMb = 5): Catalog {
  return {
    config: {
      shopOpen: "09:00",
      shopClose: "18:00",
      slotMinutes: 30,
      turnaroundMinutes: 60,
      holdMinutes: 15,
      minLeadHours: 24,
      maxDaysAhead: 180,
      photoMaxMb,
    },
    vehicleTypes: [{ id: "motorcycle", depositJpy: 5000, sort: 0, texts: texts({ name: "Motorcycle" }) }],
    rateClasses: [{ id: "r-125cc", grp: "bike", sort: 0, extensionPerHourJpy: 1000, texts: texts({ name: "125cc" }) }],
    models: models.map(({ id, photos, active = true }, sort) => ({
      id,
      typeId: "motorcycle",
      engineCc: 125,
      licenseClass: "small",
      sort,
      active,
      rateClassId: "r-125cc",
      brand: "Test",
      seats: null,
      texts: texts({ name: id, summary: "A summary", description: "A description" }),
      photos,
    })),
    vehicles: [],
    packages: [],
    prices: [],
    options: [],
    cancellationTiers: [],
    closedDates: [],
  };
}

/** `length` bytes that differ by `seed`, so two seeds of one length are two different files. */
export function photoBytes(seed: number, length = 48 + (seed % 16)): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => (0xf0 + i * 37 + seed * 101) & 0xff);
}

/** What Drive reports as md5Checksum, worked out here and never by the code under test. */
export function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}
