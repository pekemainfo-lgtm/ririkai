import { test } from "node:test";
import assert from "node:assert/strict";
import { toJstDate } from "../lib/dates.mjs";

test("UTC 15:00(JST 0:00翌日)はJSTの翌日として扱われる", () => {
  assert.equal(toJstDate("2026-07-17T15:00:00.000Z"), "2026-07-18");
});

test("UTC 14:59(JST 23:59)は当日として扱われる", () => {
  assert.equal(toJstDate("2026-07-17T14:59:00.000Z"), "2026-07-17");
});

test("不正な日時文字列は先頭10文字を返す", () => {
  assert.equal(toJstDate("not-a-date"), "not-a-date");
});
