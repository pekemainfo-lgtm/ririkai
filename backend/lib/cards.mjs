// カード関連の純ロジック。AWS SDKに依存しないので単体テスト可能。

const VALID_CARD_TYPES = new Set([
  "definition",
  "difference",
  "condition",
  "procedure",
  "cause_effect",
  "component",
  "example",
  "misconception",
  "comparison"
]);

// 問い・答えの表記ゆれを吸収して比較・重複判定に使うキー。
// legacy/summary.html の normalizeCardText と同等（小文字化・空白除去・句読点/疑問符除去）。
export function normalizeQuestion(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[？?。、．，,.!！:：;；]/g, "");
}

// ISO日時(UTC)を日本時間の日付(YYYY-MM-DD)に変換し、daysOffset日ずらす。
export function jstDateWithOffset(isoString, daysOffset = 0) {
  const t = Date.parse(isoString);
  const base = Number.isFinite(t) ? t : Date.now();
  return new Date(base + 9 * 60 * 60 * 1000 + daysOffset * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export function sanitizeCardType(value) {
  const v = String(value || "").trim();
  return VALID_CARD_TYPES.has(v) ? v : "definition";
}

function toSupplement(value, max = 8) {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x || "").trim()).filter(Boolean).slice(0, max);
}

// 採用時のDynamoDB CARDアイテムを組み立てる。
// review は §12・§16.2 に沿って初期化（初回復習日=翌日JST）。
export function buildCardItem({
  userId,
  cardId,
  qualification = "",
  subject = "",
  cardType,
  conceptKey = "",
  question,
  canonicalAnswer,
  supplement = [],
  sourceSessionId = "",
  answerSource = "ai",
  now = new Date().toISOString()
}) {
  const nextReviewDate = jstDateWithOffset(now, 1);

  return {
    PK: `USER#${userId}`,
    SK: `CARD#${cardId}`,
    type: "CARD",
    cardId,
    userId,
    qualification: String(qualification || "").trim(),
    subject: String(subject || "").trim(),
    cardType: sanitizeCardType(cardType),
    conceptKey: String(conceptKey || "").trim(),
    question: String(question || "").trim(),
    normalizedQuestion: normalizeQuestion(question),
    canonicalAnswer: String(canonicalAnswer || "").trim(),
    supplement: toSupplement(supplement),
    sourceSessionIds: sourceSessionId ? [sourceSessionId] : [],
    answerSource: answerSource === "user" ? "user" : "ai",
    status: "active",
    createdAt: now,
    updatedAt: now,
    review: {
      lastReviewedAt: null,
      nextReviewDate,
      reviewCount: 0,
      correctCount: 0,
      uncertainCount: 0,
      incorrectCount: 0,
      masteryLevel: 0
    }
  };
}

// 採用・編集時の入力検証。question と canonicalAnswer は必須。
export function validateCardInput(card) {
  const question = String(card?.question || "").trim();
  const canonicalAnswer = String(card?.canonicalAnswer || "").trim();

  if (!question) {
    return { ok: false, errorCode: "NO_QUESTION", message: "質問が未入力です。" };
  }
  if (!canonicalAnswer) {
    return { ok: false, errorCode: "NO_ANSWER", message: "答えが未入力です。" };
  }
  return { ok: true };
}

// AI生成カード候補の正規化（件数上限・空要素除去・型の担保）。
export function normalizeCardCandidates(cards, max = 10) {
  if (!Array.isArray(cards)) return [];
  return cards
    .map((card) => ({
      cardType: sanitizeCardType(card?.cardType),
      conceptKey: String(card?.conceptKey || "").trim(),
      question: String(card?.question || "").trim(),
      canonicalAnswer: String(card?.canonicalAnswer || "").trim(),
      supplement: toSupplement(card?.supplement),
      reason: String(card?.reason || "").trim()
    }))
    .filter((card) => card.question && card.canonicalAnswer)
    .slice(0, max);
}
