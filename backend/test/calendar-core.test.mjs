import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateCardsByDate } from "../../web/calendar-core.mjs";

const cards = [
  // 07-18 に採用、次回復習は 07-19
  { status: "active", createdAt: "2026-07-18T01:00:00.000Z", review: { nextReviewDate: "2026-07-19" } },
  // 07-18 に採用、次回復習は今日(07-18)＝due
  { status: "active", createdAt: "2026-07-18T02:00:00.000Z", review: { nextReviewDate: "2026-07-18" } },
  // 07-17 に採用、次回復習は 07-16（today以前）＝due
  { status: "active", createdAt: "2026-07-17T05:00:00.000Z", review: { nextReviewDate: "2026-07-16" } },
  // 要確認（集計の newCards/scheduled には数えるが due には数えない）
  { status: "needs_review", createdAt: "2026-07-18T03:00:00.000Z", review: { nextReviewDate: "2026-07-18" } },
  // merged は除外
  { status: "merged", createdAt: "2026-07-18T04:00:00.000Z", review: { nextReviewDate: "2026-07-18" } }
];

test("aggregateCardsByDate は新規カード数を採用日ごとに数える（merged のみ除外）", () => {
  const { byDate } = aggregateCardsByDate(cards, "2026-07-18");
  // 07-18作成の active 2枚 ＋ needs_review 1枚。merged は除外。
  assert.equal(byDate["2026-07-18"].newCards, 3);
  assert.equal(byDate["2026-07-17"].newCards, 1);
});

test("aggregateCardsByDate は復習予定を予定日ごとに数える", () => {
  const { byDate } = aggregateCardsByDate(cards, "2026-07-18");
  assert.equal(byDate["2026-07-19"].scheduledReviews, 1);
  assert.equal(byDate["2026-07-18"].scheduledReviews, 1);
  assert.equal(byDate["2026-07-16"].scheduledReviews, 1);
});

test("aggregateCardsByDate は due件数と要確認件数を返す", () => {
  const { dueCount, needsReviewCount } = aggregateCardsByDate(cards, "2026-07-18");
  // due: 07-18 と 07-16 の active カード（needs_review/merged は除外）
  assert.equal(dueCount, 2);
  assert.equal(needsReviewCount, 1);
});

test("aggregateCardsByDate は空配列で 0 を返す", () => {
  const { byDate, dueCount, needsReviewCount } = aggregateCardsByDate([], "2026-07-18");
  assert.deepEqual(byDate, {});
  assert.equal(dueCount, 0);
  assert.equal(needsReviewCount, 0);
});
