// Which of a price row's two prices a booking pays (#131). A row may carry an advance price, for a guest who books by 23:59
// JST the day before the pickup; anyone booking on the pickup's JST date, or later, pays the regular price.
import { epochToJst, jstToEpoch } from "./time.ts";
import type { Package, Price } from "./types.ts";

/** The two prices of a row. advancePriceJpy is null where the row has none. */
export type PriceAmounts = Pick<Price, "priceJpy" | "advancePriceJpy">;

/** Whether a booking made at `bookedAt` is ahead of a pickup at `startAt`: its JST date is before the pickup's. */
export function bookedAhead(bookedAt: number, startAt: number): boolean {
  return epochToJst(bookedAt).date < epochToJst(startAt).date;
}

/** What a booking made at `bookedAt` pays for a pickup at `startAt`: the advance price when it applies, else the regular one. */
export function applicablePrice(price: PriceAmounts, bookedAt: number, startAt: number): number {
  const { priceJpy, advancePriceJpy } = price;
  return advancePriceJpy !== null && bookedAhead(bookedAt, startAt) ? advancePriceJpy : priceJpy;
}

/**
 * The price a page shows a guest at `now` for a pickup on `pickupDate` (YYYY-MM-DD, already checked), or the regular price
 * while no date is chosen. Only the date decides, so a page can price a date before the guest picks a time.
 */
export function shownPrice(price: PriceAmounts, pickupDate: string | undefined, now: number): number {
  return pickupDate === undefined ? price.priceJpy : applicablePrice(price, now, jstToEpoch(pickupDate));
}

/** A rate class's shown price for each package it has a row for, in the order of `packages`. */
export function packagePrices(
  packages: Package[],
  prices: Price[],
  rateClassId: string,
  pickupDate: string | undefined,
  now: number,
): { pkg: Package; priceJpy: number }[] {
  return packages.flatMap((pkg) => {
    const price = prices.find((row) => row.rateClassId === rateClassId && row.packageId === pkg.id);
    return price === undefined ? [] : [{ pkg, priceJpy: shownPrice(price, pickupDate, now) }];
  });
}
