// The domain types, camelCase over the snake_case columns of migrations/0002_core.sql. A column that may be NULL is
// `| null`, times are epoch ms UTC and money is integer JPY. JSON columns (texts, photos) and 0/1 flags hold their decoded
// values here.
import type { Locale } from "./locale.ts";

export type BookingStatus = "ON_HOLD" | "PAYMENT_PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";

export type BookingSource = "web" | "block" | "staff";

export type VehicleTypeId = "scooter" | "motorcycle" | "car" | "ebike";

/** `none` is an e-bike's, which needs no license, and only an e-bike's. */
export type LicenseClass = "moped" | "small" | "standard" | "large" | "car" | "none";

export type VehicleStatus = "active" | "maintenance" | "retired";

/** Which part of the fee schedule a rate class or an option belongs to. */
export type RateGroup = "bike" | "car" | "ebike";

/** A decoded `texts` column: the same fields under every locale. */
export type LocalizedTexts<T> = Record<Locale, T>;

export type ShopConfig = {
  shopOpen: string;
  shopClose: string;
  slotMinutes: number;
  turnaroundMinutes: number;
  holdMinutes: number;
  minLeadHours: number;
  maxDaysAhead: number;
  photoMaxMb: number;
};

export type VehicleType = {
  id: VehicleTypeId;
  depositJpy: number;
  sort: number;
  texts: LocalizedTexts<{ name: string }>;
};

/** A row of the shop's fee schedule, for example 125cc or K-Car. Prices belong here, not to a model. */
export type RateClass = {
  id: string;
  grp: RateGroup;
  sort: number;
  extensionPerHourJpy: number | null;
  texts: LocalizedTexts<{ name: string }>;
};

export type Model = {
  id: string;
  typeId: VehicleTypeId;
  /** Null only for an e-bike, which has no engine. */
  engineCc: number | null;
  licenseClass: LicenseClass;
  sort: number;
  active: boolean;
  rateClassId: string;
  brand: string;
  seats: number | null;
  texts: LocalizedTexts<{ name: string; summary: string; description: string }>;
  /** Drive file names. */
  photos: string[];
};

export type Vehicle = {
  plate: string;
  modelId: string;
  status: VehicleStatus;
  odometerKm: number | null;
  baseUsageDays: number;
};

/** How long a package lasts: exactly one of days and hours, as the table's CHECK says. `rentalEnd` reads it. */
export type PackageLength = { days: number; hours: null } | { days: null; hours: number };

export type Package = {
  id: string;
  sort: number;
  texts: LocalizedTexts<{ name: string }>;
} & PackageLength;

export type Price = {
  rateClassId: string;
  packageId: string;
  priceJpy: number;
  /** The price for booking by the day before (#131), at most priceJpy, or null for none: src/lib/pricing.ts applies it. */
  advancePriceJpy: number | null;
};

/** A priced extra on the fee schedule. */
export type Option = {
  id: string;
  grp: RateGroup;
  sort: number;
  baseJpy: number;
  extraPerHourJpy: number | null;
  extraPer24hJpy: number | null;
  texts: LocalizedTexts<{ name: string }>;
};

export type CancellationTier = {
  minDaysBefore: number;
  refundPercent: number;
};

/** Everything one publish replaces. `catalog_meta` (the version and when it was published) is not part of it. */
export type Catalog = {
  config: ShopConfig;
  vehicleTypes: VehicleType[];
  rateClasses: RateClass[];
  models: Model[];
  vehicles: Vehicle[];
  packages: Package[];
  prices: Price[];
  options: Option[];
  cancellationTiers: CancellationTier[];
  /** YYYY-MM-DD. */
  closedDates: string[];
};

export type Booking = {
  id: string;
  ref: string;
  status: BookingStatus;
  source: BookingSource;
  modelId: string;
  /** Not a foreign key: a package can leave the catalog while bookings of it remain. */
  packageId: string | null;
  vehiclePlate: string;
  startAt: number;
  endAt: number;
  expiresAt: number | null;
  priceJpy: number | null;
  depositJpy: number | null;
  catalogVersion: number | null;
  locale: Locale | null;
  guestFamilyName: string | null;
  guestGivenName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  externalRef: string | null;
  externalChannel: string | null;
  contentHash: string | null;
  paymentId: string | null;
  paymentAttempt: number;
  paidJpy: number;
  cancelReason: string | null;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
  cancelledAt: number | null;
};
