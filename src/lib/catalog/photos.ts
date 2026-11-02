// The photo copy: syncPhotos copies the Drive files that active models name to R2, one capped batch per call, so the site
// never links Drive. Keys hold the md5, which makes an object immutable: a changed file gets a new key, and the old object
// stays for pages already cached and for staff going back to that version. Nothing here reads `env`.
import { readCatalog } from "../db/catalog-store.ts";
import type { DriveClient, DriveFile } from "../google/drive.ts";
import type { Model } from "../types.ts";

type SyncDeps = {
  db: D1Database;
  media: Pick<R2Bucket, "put" | "head">;
  drive: DriveClient;
  folderId: string;
  now: number;
  maxPerRun?: number;
  maxBytes: number;
};

type SyncResult = {
  /** Names whose row this call wrote. */
  copied: string[];
  /** Names whose row already points at the file in the folder. */
  skipped: string[];
  /** Names reported on every call until staff fix them. They do not count in `remaining`, so a caller's loop ends. */
  errors: { name: string; message: string }[];
  /** Names left for the next call. */
  remaining: number;
};

/** Photo name to R2 key. */
export type PhotoIndex = ReadonlyMap<string, string>;

/** A file that passed every check, with the key it is stored under. */
type Photo = DriveFile & { md5Checksum: string; size: number; key: string };

// A copy is one outbound fetch, the Drive GET, plus an R2 head and put and a D1 write. With the list and a token that is
// 17 fetches a call against a Worker's 50.
const MAX_PER_RUN = 15;

const EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

/** The keys of `checkFile`, and nothing else in the bucket. A tampered path holding dots cannot match. */
const PHOTO_KEY = /^photos\/[0-9a-f]{32}\.(?:jpg|png|webp)$/;

const UPSERT_SQL =
  "INSERT INTO photos (name, drive_file_id, md5, r2_key, content_type, bytes, copied_at) " +
  "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
  "ON CONFLICT(name) DO UPDATE SET drive_file_id = excluded.drive_file_id, md5 = excluded.md5, " +
  "r2_key = excluded.r2_key, content_type = excluded.content_type, bytes = excluded.bytes, copied_at = excluded.copied_at";

function referencedNames(models: Model[]): Set<string> {
  return new Set(models.filter(({ active }) => active).flatMap(({ photos }) => photos));
}

/**
 * The file a name stands for, or why it cannot be copied. The type alone picks the extension: Drive's mimeType is what the
 * object is served with, and a name can have any extension or none. Two files of one name are refused rather than one
 * being picked, since Drive's order would pick differently from one call to the next.
 */
function checkFile(matches: DriveFile[], maxBytes: number): Photo | string {
  if (matches.length === 0) return "Not in the Drive folder";
  if (matches.length > 1) return "More than one file in the Drive folder has this name";

  const [file] = matches;
  const { mimeType, md5Checksum, size } = file;
  const extension = EXTENSIONS.get(mimeType);
  if (extension === undefined) return `Type ${mimeType} is not JPEG, PNG or WebP`;
  if (md5Checksum === undefined || size === undefined) return "Drive reports no checksum or size for this file";
  if (size > maxBytes) return `${size} bytes is over the limit of ${maxBytes}`;
  return { ...file, md5Checksum, size, key: `photos/${md5Checksum}.${extension}` };
}

/**
 * An object already there is left alone: its key says what it holds. That covers a call that stopped between the put and
 * the row, two names with the same bytes, and a file put back to an earlier version. R2 checks the bytes against the md5
 * on the put, so a cut-short download cannot sit under this key for good.
 */
async function copyPhoto({ db, media, drive, now }: SyncDeps, photo: Photo): Promise<void> {
  const { id, name, mimeType, md5Checksum, size, key } = photo;
  if ((await media.head(key)) === null) {
    const body = await drive.download(id);
    await media.put(key, body, { md5: md5Checksum, httpMetadata: { contentType: mimeType } });
  }
  await db.prepare(UPSERT_SQL).bind(name, id, md5Checksum, key, mimeType, size, now).run();
}

/**
 * Copies what the published catalog names and the bucket lacks. Only copy attempts use up `maxPerRun`: a failed one spent
 * its subrequests too, so it counts, and it lands in `errors` so that the rest of the batch still runs. A failed list
 * rejects, since it says nothing about any one name. Before the first publish there is nothing to copy.
 */
export async function syncPhotos(deps: SyncDeps): Promise<SyncResult> {
  const { db, drive, folderId, maxPerRun = MAX_PER_RUN, maxBytes } = deps;
  const result: SyncResult = { copied: [], skipped: [], errors: [], remaining: 0 };

  const catalog = await readCatalog(db);
  if (catalog === null) return result;

  const listed = await drive.listFolder(folderId);
  const index = await readPhotoIndex(db);
  let attempts = 0;

  for (const name of referencedNames(catalog.models)) {
    const checked = checkFile(
      listed.filter((file) => file.name === name),
      maxBytes,
    );
    if (typeof checked === "string") {
      result.errors.push({ name, message: checked });
    } else if (index.get(name) === checked.key) {
      result.skipped.push(name);
    } else if (attempts >= maxPerRun) {
      result.remaining += 1;
    } else {
      attempts += 1;
      try {
        await copyPhoto(deps, checked);
        result.copied.push(name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.errors.push({ name, message: `Copy failed: ${reason}` });
      }
    }
  }
  return result;
}

/** Every copied photo, for a page to pass to `photoUrl`. */
export async function readPhotoIndex(db: D1Database): Promise<PhotoIndex> {
  const { results } = await db.prepare("SELECT name, r2_key FROM photos").all<{ name: string; r2_key: string }>();
  return new Map(results.map(({ name, r2_key }) => [name, r2_key]));
}

/** The path that serves a photo, or null for a name with no copy yet. */
export function photoUrl(name: string, index: PhotoIndex): string | null {
  const key = index.get(name);
  return key === undefined ? null : `/media/${key}`;
}

export function isPhotoKey(key: string): boolean {
  return PHOTO_KEY.test(key);
}
