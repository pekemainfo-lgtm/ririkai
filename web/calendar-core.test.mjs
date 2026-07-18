import { test } from "node:test";
import assert from "node:assert/strict";
import { monthPrefix, buildMonthGrid, aggregateByDate, shiftMonth } from "./calendar-core.mjs";

test("monthPrefixはゼロ埋めした年月を返す", () => {
  assert.equal(monthPrefix(2026, 7), "2026-07");
  assert.equal(monthPrefix(2026, 12), "2026-12");
});

test("buildMonthGrid: 2026-07は水曜始まり・31日", () => {
  const weeks = buildMonthGrid(2026, 7);
  // 2026-07-01は水曜(週の4番目, index 3)
  assert.equal(weeks[0][0], null);
  assert.equal(weeks[0][3].day, 1);
  assert.equal(weeks[0][3].dateStr, "2026-07-01");
  // 全セルの非nullは31個
  const days = weeks.flat().filter(Boolean);
  assert.equal(days.length, 31);
  assert.equal(days[30].dateStr, "2026-07-31");
});

test("buildMonthGrid: うるう年2月は29日", () => {
  const days = buildMonthGrid(2028, 2).flat().filter(Boolean);
  assert.equal(days.length, 29);
});

test("buildMonthGrid: 平年2月は28日", () => {
  const days = buildMonthGrid(2026, 2).flat().filter(Boolean);
  assert.equal(days.length, 28);
});

test("buildMonthGridの各週は長さ7", () => {
  for (const week of buildMonthGrid(2026, 7)) {
    assert.equal(week.length, 7);
  }
});

test("aggregateByDate: 同日の複数セッションを合算する", () => {
  const result = aggregateByDate([
    { studyDate: "2026-07-18", durationMinutes: 25, subject: "Networking", qualification: "AWS" },
    { studyDate: "2026-07-18", durationMinutes: 20, subject: "Linux", qualification: "LinuC" },
    { studyDate: "2026-07-19", durationMinutes: 30, subject: "Networking", qualification: "AWS" }
  ]);
  assert.equal(result["2026-07-18"].count, 2);
  assert.equal(result["2026-07-18"].totalMinutes, 45);
  assert.deepEqual(result["2026-07-18"].subjects.sort(), ["Linux", "Networking"]);
  assert.equal(result["2026-07-19"].count, 1);
  assert.equal(result["2026-07-19"].totalMinutes, 30);
});

test("aggregateByDate: 空配列は空オブジェクト", () => {
  assert.deepEqual(aggregateByDate([]), {});
});

test("aggregateByDate: studyDateが無い場合createdAtの日付を使う", () => {
  const result = aggregateByDate([{ createdAt: "2026-07-18T12:00:00.000Z", durationMinutes: 10 }]);
  assert.equal(result["2026-07-18"].count, 1);
});

test("shiftMonth: 12月から翌月は翌年1月", () => {
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
});

test("shiftMonth: 1月から前月は前年12月", () => {
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
});
