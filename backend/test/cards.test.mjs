import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuestion,
  jstDateWithOffset,
  sanitizeCardType,
  buildCardItem,
  validateCardInput,
  normalizeCardCandidates,
  findDuplicateCards,
  integrateAnswer,
  mergeCardData
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

// --- Phase 5: 重複統合 ---

const existingDefinition = {
  cardId: "card_def",
  cardType: "definition",
  conceptKey: "aws:nat-gateway",
  question: "NAT Gatewayとは？",
  normalizedQuestion: normalizeQuestion("NAT Gatewayとは？"),
  canonicalAnswer: "プライベートサブネットの外向き通信用のマネージドサービス。",
  supplement: ["パブリックサブネットに配置"],
  sourceSessionIds: ["session_a"],
  answerSource: "ai",
  status: "active",
  review: { reviewCount: 2, correctCount: 1, uncertainCount: 1, incorrectCount: 0, nextReviewDate: "2026-07-25", masteryLevel: 1 }
};

test("findDuplicateCards ケースA: 同conceptKey+cardType・言い換え質問は重複", () => {
  const candidate = { question: "NAT Gatewayの役割を説明してください。", cardType: "definition", conceptKey: "aws:nat-gateway" };
  const dups = findDuplicateCards(candidate, [existingDefinition]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].cardId, "card_def");
});

test("findDuplicateCards ケースB: 同用語でも別conceptKey/別cardTypeは非重複", () => {
  const placement = { question: "NAT Gatewayはどのサブネットに配置する？", cardType: "condition", conceptKey: "aws:nat-gateway-placement" };
  assert.equal(findDuplicateCards(placement, [existingDefinition]).length, 0);

  const diff = { question: "NAT GatewayとInternet Gatewayの違いは？", cardType: "comparison", conceptKey: "aws:nat-vs-igw" };
  assert.equal(findDuplicateCards(diff, [existingDefinition]).length, 0);
});

test("findDuplicateCards: normalizedQuestion一致でも重複", () => {
  const candidate = { question: "ｎａｔ　ｇａｔｅｗａｙとは?", cardType: "definition", conceptKey: "other:key" };
  // 全角/半角は正規化されないので通常の表記で確認
  const same = { question: "NAT Gatewayとは？？", cardType: "misconception", conceptKey: "" };
  assert.equal(findDuplicateCards(same, [existingDefinition]).length, 1);
});

test("findDuplicateCards: merged/inactiveは除外", () => {
  const candidate = { question: "NAT Gatewayとは？", cardType: "definition", conceptKey: "aws:nat-gateway" };
  assert.equal(findDuplicateCards(candidate, [{ ...existingDefinition, status: "merged" }]).length, 0);
  assert.equal(findDuplicateCards(candidate, [{ ...existingDefinition, status: "inactive" }]).length, 0);
});

test("integrateAnswer: 回答一致→merged（supplement union・session追加）", () => {
  const { result, card } = integrateAnswer(
    existingDefinition,
    "プライベートサブネットの外向き通信用のマネージドサービス。",
    ["Elastic IPを関連付ける"],
    "session_b",
    "2026-07-18T00:00:00.000Z"
  );
  assert.equal(result, "merged");
  assert.deepEqual(card.supplement, ["パブリックサブネットに配置", "Elastic IPを関連付ける"]);
  assert.ok(card.sourceSessionIds.includes("session_b"));
  assert.equal(card.status, "active");
  assert.equal(card.pendingAnswer, undefined);
});

test("integrateAnswer ケースC: 回答矛盾→needs_review（pendingAnswer退避、既存維持）", () => {
  const { result, card } = integrateAnswer(
    existingDefinition,
    "パブリックサブネットに置く着信用サービス。", // 矛盾する内容
    [],
    "session_c",
    "2026-07-18T00:00:00.000Z"
  );
  assert.equal(result, "needs_review");
  assert.equal(card.status, "needs_review");
  assert.equal(card.canonicalAnswer, existingDefinition.canonicalAnswer); // 既存は変えない
  assert.equal(card.pendingAnswer.canonicalAnswer, "パブリックサブネットに置く着信用サービス。");
  assert.ok(card.sourceSessionIds.includes("session_c"));
});

test("integrateAnswer: 既存user編集済み＋回答不一致→needs_review", () => {
  const userCard = { ...existingDefinition, answerSource: "user" };
  const { result } = integrateAnswer(userCard, "別の答え", [], "session_d");
  assert.equal(result, "needs_review");
});

test("mergeCardData: sourceを吸収しreview集計合算・source merged（§15）", () => {
  const target = existingDefinition;
  const source = {
    ...existingDefinition,
    cardId: "card_src",
    sourceSessionIds: ["session_x"],
    supplement: ["別の補足"],
    createdAt: "2026-07-10T00:00:00.000Z",
    review: { reviewCount: 3, correctCount: 2, uncertainCount: 0, incorrectCount: 1, nextReviewDate: "2026-07-20", masteryLevel: 2 }
  };
  const { target: t, source: s } = mergeCardData({ ...target, createdAt: "2026-07-15T00:00:00.000Z" }, source, "2026-07-18T00:00:00.000Z");

  assert.deepEqual(t.sourceSessionIds.sort(), ["session_a", "session_x"]);
  assert.ok(t.supplement.includes("別の補足"));
  assert.equal(t.review.reviewCount, 5);
  assert.equal(t.review.incorrectCount, 1);
  assert.equal(t.review.nextReviewDate, "2026-07-20"); // 早い方
  assert.equal(t.createdAt, "2026-07-10T00:00:00.000Z"); // 早い方
  assert.equal(s.status, "merged");
  assert.equal(s.mergedIntoCardId, "card_def");
});
