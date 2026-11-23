// POST /api/staff/bookings through the built Worker in Miniflare: the Dashboard's "Cancel a booking" panel asks for the
// bookings staff can act on, by ref, guest name or JST pickup date. Envelopes are signed here with node:crypto, the way
// the Apps Script signs them, and because WebCrypto refuses the empty secret one test needs. The route reads D1 only, so
// every test also checks that nothing in D1 changed and that no request left the Worker.
//
// Every POST says Content-Type: application/json as the Apps Script does: Astro's origin check answers 403 to a
// cross-site POST with no type, or with a form type, which is what a bare string body gets.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { LOCALES } from "../../src/lib/locale.ts";
import { seedBooking, seedModel, seedPackage, seedVehicle, type BookingRow } from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/staff/bookings";
const SECRET = testVars.PUBLISH_SECRET;
const JSON_HEADERS = { "Content-Type": "application/json" };
const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
const REQUESTED_BY = "staff@example.com";
const BAD_QUERY = { ok: false, reason: "BAD_QUERY" };

type Summary = Record<string, unknown> & { ref: string; guestName: string };
type Answer = { ok: true; bookings: Summary[] } | { ok: false; reason: string };

/** The instant of a JST wall clock written `YYYY-MM-DD HH:mm`. */
function jst(text: string): number {
  const ms = Date.parse(`${text.replace(" ", "T")}:00+09:00`);
  if (Number.isNaN(ms)) throw new Error(`not a JST wall clock: ${text}`);
  return ms;
}

function texts(nameJa: string, nameElsewhere: string): string {
  return JSON.stringify(
    Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        {
          name: locale === "ja" ? nameJa : `${nameElsewhere} (${locale})`,
          summary: "s",
          description: "d",
        },
      ]),
    ),
  );
}

const outboundRequests: string[] = [];
let worker: TestWorker;
/** The seeded bookings staff may act on, by name. */
const seeded: Record<string, BookingRow> = {};
let modelId = "";
let packageId = "";

before(async () => {
  worker = await startWorker({
    outbound: (request) => {
      outboundRequests.push(`${request.method} ${request.url}`);
      return new Response("no outbound request is expected", { status: 502 });
    },
  });
  const { db } = worker;
  const tricity = await seedModel(db, {
    texts: texts("トリシティ125", "Tricity 125"),
  });
  const pcx = await seedModel(db, { texts: texts("PCX125", "PCX") });
  const day = await seedPackage(db, {
    days: 1,
    texts: texts("1日パック", "One day"),
  });
  modelId = tricity.id;
  packageId = day.id;
  await seedVehicle(db, { plate: "沖縄 わ 12-34", model_id: tricity.id });
  await seedVehicle(db, { plate: "沖縄 わ 56-78", model_id: pcx.id });
  const tricityBike = { model_id: tricity.id, vehicle_plate: "沖縄 わ 12-34" };
  const pcxBike = { model_id: pcx.id, vehicle_plate: "沖縄 わ 56-78" };
  const now = Date.now();

  // 23:30 JST on the 15th is 14:30 UTC on the 15th; it is picked up on the 15th.
  seeded.yamadaHanako = await seedBooking(db, {
    ...tricityBike,
    ref: "7K2MQ9XA",
    package_id: day.id,
    guest_family_name: "Yamada",
    guest_given_name: "Hanako",
    guest_email: "hanako@example.com",
    guest_phone: "+81-90-1234-5678",
    price_jpy: 15400,
    deposit_jpy: 6000,
    paid_jpy: 4500,
    start_at: jst("2030-07-15 23:30"),
    end_at: jst("2030-07-16 23:30"),
  });
  seeded.tanakaHanako = await seedBooking(db, {
    ...pcxBike,
    ref: "P4N8W2RT",
    guest_family_name: "Tanaka",
    guest_given_name: "Hanako",
    start_at: jst("2030-07-15 10:00"),
  });
  // 08:00 JST on the 16th is 23:00 UTC on the 15th; it is picked up on the 16th.
  seeded.yamadaTaro = await seedBooking(db, {
    ...tricityBike,
    ref: "T7R9Y3KD",
    guest_family_name: "Yamada",
    guest_given_name: "Taro",
    start_at: jst("2030-07-16 08:00"),
  });

  // Never listed, though each is a Hanako picked up on the 15th, or has ended.
  const hanako = { guest_family_name: "Yamada", guest_given_name: "Hanako" };
  await seedBooking(db, {
    ...tricityBike,
    ...hanako,
    status: "CANCELLED",
    start_at: jst("2030-07-15 12:00"),
  });
  await seedBooking(db, {
    ...tricityBike,
    ...hanako,
    source: "block",
    external_ref: "BLK-1",
    start_at: jst("2030-07-15 13:00"),
  });
  await seedBooking(db, {
    ...tricityBike,
    ...hanako,
    status: "ON_HOLD",
    expires_at: jst("2030-07-15 00:00"),
    start_at: jst("2030-07-15 14:00"),
  });
  await seedBooking(db, {
    ...tricityBike,
    ...hanako,
    status: "EXPIRED",
    start_at: jst("2030-07-15 15:00"),
  });
  await seedBooking(db, {
    ...tricityBike,
    ...hanako,
    start_at: now - 2 * DAY_MS,
    end_at: now - DAY_MS,
  });
});

after(async () => {
  await worker?.stop();
});

/** The envelope the Apps Script sends: an HMAC-SHA256 in hex over `ts.payload`, with the payload as JSON text. */
function envelope(secret: string, payload: unknown, ts = Date.now()) {
  const text = JSON.stringify(payload);
  return {
    ts,
    payload: text,
    sig: createHmac("sha256", secret).update(`${ts}.${text}`).digest("hex"),
  };
}

function post(body: string, to: TestWorker = worker): Promise<Response> {
  return to.fetch(PATH, { method: "POST", headers: JSON_HEADERS, body });
}

function postWithLength(body: string): Promise<Response> {
  const headers = {
    ...JSON_HEADERS,
    "Content-Length": String(Buffer.byteLength(body)),
  };
  return worker.fetch(PATH, { method: "POST", headers, body });
}

async function search(query: Record<string, unknown>): Promise<Answer> {
  const res = await post(JSON.stringify(envelope(SECRET, { requestedBy: REQUESTED_BY, ...query })));
  const text = await res.text();
  assert.equal(res.status, 200, `${JSON.stringify(query)}: ${text}`);
  return JSON.parse(text) as Answer;
}

async function refsFound(query: Record<string, unknown>): Promise<string[]> {
  const answer = await search(query);
  assert.equal(answer.ok, true, `${JSON.stringify(query)}: ${JSON.stringify(answer)}`);
  assert.deepEqual(Object.keys(answer).sort(), ["bookings", "ok"], JSON.stringify(answer));
  return (answer as { bookings: Summary[] }).bookings.map(({ ref }) => ref);
}

/** Every table of D1 but the token cache. */
async function d1Contents(db: D1Database = worker.db): Promise<Record<string, unknown[]>> {
  const { results: tables } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
        "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'kv_cache' ORDER BY name",
    )
    .all<{ name: string }>();
  const contents: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    contents[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results;
  }
  return contents;
}

test("a signed search answers the matching bookings", async () => {
  const before = await d1Contents();
  const { yamadaHanako, tanakaHanako, yamadaTaro } = seeded;

  const FINDS: [Record<string, unknown>, BookingRow[]][] = [
    [{ text: "hanako" }, [tanakaHanako, yamadaHanako]],
    [{ text: "Hanako Yamada" }, [yamadaHanako]],
    [{ text: "Yamada Hanako" }, [yamadaHanako]],
    [{ text: "7k2mq9xa" }, [yamadaHanako]],
    [{ text: "７Ｋ２ＭＱ９ＸＡ" }, [yamadaHanako]],
    [{ text: "7K2MQ9X" }, []],
    [{ text: "yamada" }, [yamadaHanako, yamadaTaro]],
    [{ text: "Ka%to" }, []],
    [{ date: "2030-07-15" }, [tanakaHanako, yamadaHanako]],
    [{ date: "2030-07-16" }, [yamadaTaro]],
    [{ date: "2030-07-14" }, []],
    [{ text: "yamada", date: "2030-07-16" }, [yamadaTaro]],
    [{ text: "taro", date: "2030-07-15" }, []],
    [{}, [tanakaHanako, yamadaHanako, yamadaTaro]],
  ];
  for (const [query, expected] of FINDS) {
    assert.deepEqual(
      await refsFound(query),
      expected.map(({ ref }) => ref),
      JSON.stringify(query),
    );
  }

  const answer = await search({ text: "7K2MQ9XA" });
  assert.ok(answer.ok);
  const [found] = answer.bookings;
  assert.ok(found, "the ref found nothing");
  const { guestName, ...rest } = found;
  assert.deepEqual(rest, {
    id: yamadaHanako.id,
    ref: "7K2MQ9XA",
    status: "CONFIRMED",
    source: "web",
    modelId,
    modelNameJa: "トリシティ125",
    packageId,
    packageNameJa: "1日パック",
    plate: "沖縄 わ 12-34",
    startAt: jst("2030-07-15 23:30"),
    endAt: jst("2030-07-16 23:30"),
    guestEmail: "hanako@example.com",
    guestPhone: "+81-90-1234-5678",
    priceJpy: 15400,
    depositJpy: 6000,
    paidJpy: 4500,
  });
  assert.match(guestName, /Yamada/);
  assert.match(guestName, /Hanako/);

  assert.deepEqual(await d1Contents(), before, "a search changed D1");
  assert.deepEqual(outboundRequests, [], "a search made an outbound request");
});

test("a bad date or a long text answers BAD_QUERY", async () => {
  const before = await d1Contents();
  const BAD: Record<string, unknown>[] = [
    { date: "2030-02-30" },
    { date: "2030-02-29" },
    { date: "2030-04-31" },
    { date: "2030-13-01" },
    { date: "2030-00-10" },
    { date: "2030-07-00" },
    { date: "2030-7-15" },
    { date: "20300715" },
    { date: "2030/07/15" },
    { date: "2030-07-15T00:00" },
    { date: "15/07/2030" },
    { date: "tomorrow" },
    { text: "x".repeat(101) },
    { text: "あ".repeat(101) },
    { text: "x".repeat(101), date: "2030-07-15" },
    { text: "hanako", date: "2030-02-31" },
  ];
  for (const query of BAD) {
    assert.deepEqual(await search(query), BAD_QUERY, JSON.stringify(query).slice(0, 80));
  }

  // The edges that are fine: a leap day, and 100 characters, which in Japanese is 300 bytes of UTF-8.
  const FINE: [Record<string, unknown>, string[]][] = [
    [{ date: "2032-02-29" }, []],
    [{ date: "2030-07-15" }, [seeded.tanakaHanako.ref, seeded.yamadaHanako.ref]],
    [{ text: "x".repeat(100) }, []],
    [{ text: "あ".repeat(100) }, []],
    [{ text: "y".repeat(100), date: "2030-07-15" }, []],
  ];
  for (const [query, expected] of FINE) {
    assert.deepEqual(await refsFound(query), expected, JSON.stringify(query).slice(0, 80));
  }

  assert.deepEqual(await d1Contents(), before, "a search changed D1");
  assert.deepEqual(outboundRequests, [], "a search made an outbound request");
});

test("unsigned, tampered and stale requests get 401", async () => {
  const before = await d1Contents();
  const PAYLOAD = { requestedBy: REQUESTED_BY, text: "hanako" };
  const good = () => envelope(SECRET, PAYLOAD);
  const flipped = (sig: string) => `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`;
  const without = (field: "ts" | "payload" | "sig") => {
    const { [field]: _dropped, ...rest } = good();
    return JSON.stringify(rest);
  };
  const forged = JSON.stringify({ requestedBy: REQUESTED_BY, text: "yamada" });

  const REFUSED: [string, () => string][] = [
    ["no body", () => ""],
    ["not JSON", () => "{not json"],
    ["JSON null", () => "null"],
    ["a JSON array", () => "[]"],
    ["a payload with no envelope", () => JSON.stringify(PAYLOAD)],
    ["no sig", () => without("sig")],
    ["no ts", () => without("ts")],
    ["no payload", () => without("payload")],
    ["an empty sig", () => JSON.stringify({ ...good(), sig: "" })],
    ["ts as text", () => JSON.stringify({ ...good(), ts: String(Date.now()) })],
    ["the payload as an object", () => JSON.stringify({ ...good(), payload: PAYLOAD })],
    ["signed with another secret", () => JSON.stringify(envelope("another-secret", PAYLOAD))],
    ["signed with the mail secret", () => JSON.stringify(envelope(testVars.MAIL_SECRET, PAYLOAD))],
    ["signed with the cancel-link secret", () => JSON.stringify(envelope(testVars.CANCEL_LINK_SECRET, PAYLOAD))],
    ["payload changed after signing", () => JSON.stringify({ ...good(), payload: forged })],
    ["ts changed after signing", () => JSON.stringify({ ...good(), ts: Date.now() + 1000 })],
    ["one sig character changed", () => JSON.stringify({ ...good(), sig: flipped(good().sig) })],
    ["a cut-off sig", () => JSON.stringify({ ...good(), sig: good().sig.slice(0, 32) })],
    ["stale by ten minutes", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 10 * MINUTE_MS))],
    ["stale by a day", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - DAY_MS))],
    ["ten minutes in the future", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() + 10 * MINUTE_MS))],
  ];

  for (const [name, body] of REFUSED) {
    const res = await post(body());
    const text = await res.text();
    assert.equal(res.status, 401, `${name}: ${text}`);
    assert.deepEqual(JSON.parse(text), { error: "unauthorized" }, name);
  }

  // The same signing with the right secret gets through, so what turned those down was the signature check.
  assert.deepEqual(await refsFound({ text: "hanako" }), [seeded.tanakaHanako.ref, seeded.yamadaHanako.ref]);

  assert.deepEqual(await d1Contents(), before, "a refused request changed D1");
  assert.deepEqual(outboundRequests, [], "a refused request made an outbound request");
});

test("a body over 64 KB gets 413 and an empty PUBLISH_SECRET gets 500", async () => {
  const before = await d1Contents();
  const TOO_LARGE = "The request is too large.";

  /** A good envelope of exactly `bytes`, its requestedBy padded with "x". */
  const sized = (bytes: number): string => {
    const ts = Date.now();
    const body = (pad: string) =>
      JSON.stringify(envelope(SECRET, { requestedBy: `${REQUESTED_BY}${pad}`, text: "hanako" }, ts));
    const text = body("x".repeat(bytes - Buffer.byteLength(body(""))));
    assert.equal(Buffer.byteLength(text), bytes);
    return text;
  };

  const SENDS: [string, (body: string) => Promise<Response>][] = [
    ["as a string", (body) => post(body)],
    ["with a Content-Length", postWithLength],
  ];
  // Signed, so only the limit can refuse them, and one byte over 64 KiB, the larger reading of 64 KB.
  const BODIES: [string, string][] = [
    ["a signed envelope one byte past 64 KiB", sized(65_537)],
    ["a signed envelope of 100,000 bytes", sized(100_000)],
    ["junk", "x".repeat(70_000)],
  ];
  for (const [name, body] of BODIES) {
    for (const [how, send] of SENDS) {
      const label = `${name} ${how}`;
      const res = await send(body);
      const text = await res.text();
      assert.equal(res.status, 413, label);
      assert.equal(text, TOO_LARGE, label);
      assert.equal(text.includes("Hanako"), false, label);
    }
  }

  // 64,000 bytes is within the limit on either reading.
  for (const [how, send] of SENDS) {
    const res = await send(sized(64_000));
    assert.notEqual(res.status, 413, how);
    assert.notEqual(res.status, 401, how);
    await res.body?.cancel();
  }
  assert.deepEqual(await d1Contents(), before, "a large request changed D1");

  // A Worker with no secret refuses everyone, even a body signed with the key anyone can compute for it.
  const CASES: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  for (const [name, secret] of CASES) {
    const lonely = await startWorker({
      vars: { PUBLISH_SECRET: secret },
      outbound: (request) => {
        outboundRequests.push(`${request.method} ${request.url}`);
        return new Response("no outbound request is expected", { status: 502 });
      },
    });
    try {
      await seedBooking(lonely.db, {
        guest_family_name: "Yamada",
        guest_given_name: "Hanako",
      });
      const lonelyBefore = await d1Contents(lonely.db);
      for (const key of ["", "undefined"]) {
        const label = `${name}, signed with ${JSON.stringify(key)}`;
        const body = JSON.stringify(envelope(key, { requestedBy: REQUESTED_BY, text: "hanako" }));
        const res = await post(body, lonely);
        const text = await res.text();
        assert.equal(res.status, 500, label);
        // Plain words staff can read, carrying no booking and nothing of the crypto that refused the key.
        assert.ok(text.trim().length > 0 && text.length <= 200, `${label}: ${JSON.stringify(text)}`);
        assert.doesNotMatch(text, /^\s*[{[<"]/, `${label}: ${text}`);
        assert.doesNotMatch(text, /Hanako|DataError|HMAC|importKey|key length/i, label);
      }
      assert.deepEqual(await d1Contents(lonely.db), lonelyBefore, `${name}: D1 changed`);
    } finally {
      await lonely.stop();
    }
  }
  assert.deepEqual(outboundRequests, [], "a refused request made an outbound request");
});
