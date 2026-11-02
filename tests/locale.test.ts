// The four site locales and the guard that narrows unknown input to them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { isLocale, LOCALES } from "../src/lib/locale.ts";

test("isLocale accepts exactly ja, en, zh-cn and ko", () => {
  const codes = ["ja", "en", "zh-cn", "ko"];
  assert.deepEqual([...LOCALES], codes);
  for (const code of codes) {
    assert.equal(isLocale(code), true, code);
  }

  const rejected: unknown[] = [
    // Near misses of the codes.
    "zh",
    "zh-tw",
    "zh_cn",
    "zh-hans",
    "cn",
    "jp",
    "kr",
    "en-us",
    "en-US",
    "ko-KR",
    "ja-JP",
    "fr",
    "",
    // Names every object inherits, for a guard built on `in` or a bare lookup.
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "length",
    "0",
    // Not strings at all, including values that stringify to a code.
    0,
    1,
    Number.NaN,
    null,
    undefined,
    true,
    false,
    {},
    [],
    ["ja"],
    new String("ja"),
    { toString: () => "ja" },
    Symbol("ja"),
  ];
  for (const code of codes) {
    rejected.push(code.toUpperCase(), ` ${code}`, `${code} `, `${code}\n`, `${code}-`, `${code}x`);
  }
  for (const value of rejected) {
    assert.equal(isLocale(value), false, `isLocale(${inspect(value)})`);
  }

  // Every other two-letter code.
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (const first of letters) {
    for (const second of letters) {
      const code = first + second;
      assert.equal(isLocale(code), codes.includes(code), code);
    }
  }
});
