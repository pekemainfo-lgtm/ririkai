import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuestion,
  jstDateWithOffset,
  sanitizeCardType,
  buildCardItem,
  validateCardInput,
  normalizeCardCandidates
} from "../lib/cards.mjs";

test("normalizeQuestion: 表記ゆれ（空白・句読点・大小）を吸収する", () => {
  assert.equal(
    normalizeQuestion("NAT Gatewayとは？"),
    normalizeQuestion("nat gateway とは")
  );
  assert.equal(normalizeQuestion("A、B。C！"), "abc");
});

test("jstDateWithOffset: 翌日を返す（JST基準）", () => {
  // UTC 2026-07-18T14:59Z = JST 2026-07-18 23:59 → +1日で 07-19
  assert.equal(jstDateWithOffset("2026-07-18T14:59:00.000Z", 1), "2026-07-19");
  assert.equal(jstDateWithOffset("2026-07-18T00:00:00.000Z", 0), "2026-07-18");
});

test("sanitizeCardType: 未知の型はdefinitionにフォールバック", () => {
  assert.equal(sanitizeCardType("difference"), "difference");
  assert.equal(sanitizeCardType("bogus"), "definition");
  assert.equal(sanitizeCardType(""), "definition");
});

test("buildCardItem: キーとreview初期化・normalizedQuestion付与", () => {
  const item = buildCardItem({
    userId: "naohiro",
    cardId: "card_abc",
    qualification: "AWS",
    subject: "Networking",
    cardType: "definition",
    conceptKey: "aws:nat-gateway",
    question: "NAT Gatewayとは？",
    canonicalAnswer: "プライベートサブネットの外向き通信用サービス。",
    supplement: ["パブリックサブネットに配置", ""],
    sourceSessionId: "session_x",
    answerSource: "ai",
    now: "2026-07-18T05:00:00.000Z"
  });

  assert.equal(item.PK, "USER#naohiro");
  assert.equal(item.SK, "CARD#card_abc");
  assert.equal(item.normalizedQuestion, "natgatewayとは");
  assert.deepEqual(item.sourceSessionIds, ["session_x"]);
  assert.deepEqual(item.supplement, ["パブリックサブネットに配置"]); // 空要素除去
  assert.equal(item.answerSource, "ai");
  assert.equal(item.status, "active");
  assert.equal(item.review.reviewCount, 0);
  // 2026-07-18T05:00Z = JST 14:00 → 翌日 07-19
  assert.equal(item.review.nextReviewDate, "2026-07-19");
});

test("buildCardItem: answerSourceはuser以外aiに正規化", () => {
  const a = buildCardItem({ userId: "u", cardId: "c1", question: "q", canonicalAnswer: "a", answerSource: "user" });
  const b = buildCardItem({ userId: "u", cardId: "c2", question: "q", canonicalAnswer: "a", answerSource: "weird" });
  assert.equal(a.answerSource, "user");
  assert.equal(b.answerSource, "ai");
});

test("validateCardInput: question/answer必須", () => {
  assert.equal(validateCardInput({ question: "q", canonicalAnswer: "a" }).ok, true);
  assert.equal(validateCardInput({ canonicalAnswer: "a" }).errorCode, "NO_QUESTION");
  assert.equal(validateCardInput({ question: "q" }).errorCode, "NO_ANSWER");
});

test("normalizeCardCandidates: 空要素除去と上限", () => {
  const raw = [
    { question: "q1", canonicalAnswer: "a1", cardType: "definition", supplement: ["s"] },
    { question: "", canonicalAnswer: "a2" }, // question無し→除外
    { question: "q3", canonicalAnswer: "" }  // answer無し→除外
  ];
  const result = normalizeCardCandidates(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].question, "q1");

  const many = Array.from({ length: 15 }, (_, i) => ({ question: `q${i}`, canonicalAnswer: "a" }));
  assert.equal(normalizeCardCandidates(many).length, 10);
});
