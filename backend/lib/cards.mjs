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

// --- Phase 5: 重複統合 ---

// 回答比較用の正規化（質問と同系。重複・矛盾の比較に使う）。
export function normalizeAnswer(text) {
  return normalizeQuestion(text);
}

function unionStrings(a, b, max = 12) {
  const seen = new Set();
  const result = [];
  for (const x of [...(a || []), ...(b || [])]) {
    const s = String(x || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    result.push(s);
    if (result.length >= max) break;
  }
  return result;
}

// 候補カードと重複する既存カードを探す（§10.4 初期版・§28.6）。
// 除外: status が merged / inactive のカード。
// マッチ: (conceptKey非空で一致 かつ cardType一致) または normalizedQuestion一致。
export function findDuplicateCards(candidate, existingCards) {
  const candType = sanitizeCardType(candidate?.cardType);
  const candConcept = String(candidate?.conceptKey || "").trim();
  const candNormQ = normalizeQuestion(candidate?.question);

  return (existingCards || []).filter((card) => {
    if (!card) return false;
    if (card.status === "merged" || card.status === "inactive") return false;

    const sameConceptType =
      candConcept && String(card.conceptKey || "").trim() === candConcept &&
      sanitizeCardType(card.cardType) === candType;

    const sameQuestion =
      candNormQ && String(card.normalizedQuestion || normalizeQuestion(card.question)) === candNormQ;

    return sameConceptType || sameQuestion;
  });
}

// 既存カードへ新しい回答を統合する（§11）。
// - 既存が user 編集済みで回答が異なる → needs_review（§14：勝手に上書きしない）
// - 回答が正規化一致 → merged（回答は既存維持、supplementをunion、sourceSessionIds追加）
// - それ以外（回答が異なる） → needs_review（既存維持・pendingAnswerに新規退避）（§11.4）
export function integrateAnswer(existingCard, newAnswer, newSupplement, newSessionId, now = new Date().toISOString()) {
  const answer = String(newAnswer || "").trim();
  const supplement = toSupplement(newSupplement);
  const sameAnswer = normalizeAnswer(existingCard.canonicalAnswer) === normalizeAnswer(answer);

  const withSession = newSessionId && !(existingCard.sourceSessionIds || []).includes(newSessionId)
    ? [...(existingCard.sourceSessionIds || []), newSessionId]
    : (existingCard.sourceSessionIds || []);

  if (sameAnswer) {
    return {
      result: "merged",
      card: {
        ...existingCard,
        supplement: unionStrings(existingCard.supplement, supplement),
        sourceSessionIds: withSession,
        status: existingCard.status === "needs_review" ? existingCard.status : "active",
        updatedAt: now
      }
    };
  }

  // 回答が異なる（user編集済みか否かを問わず）→ 自動確定せず利用者へ（§11.4/§14）
  return {
    result: "needs_review",
    card: {
      ...existingCard,
      status: "needs_review",
      pendingAnswer: {
        canonicalAnswer: answer,
        supplement,
        sourceSessionId: newSessionId || ""
      },
      sourceSessionIds: withSession,
      updatedAt: now
    }
  };
}

function sumReview(a = {}, b = {}) {
  const pick = (o, k) => Number(o?.[k] || 0);
  const minDate = (x, y) => {
    if (!x) return y;
    if (!y) return x;
    return x < y ? x : y;
  };
  return {
    lastReviewedAt: a.lastReviewedAt || b.lastReviewedAt || null,
    nextReviewDate: minDate(a.nextReviewDate, b.nextReviewDate),
    reviewCount: pick(a, "reviewCount") + pick(b, "reviewCount"),
    correctCount: pick(a, "correctCount") + pick(b, "correctCount"),
    uncertainCount: pick(a, "uncertainCount") + pick(b, "uncertainCount"),
    incorrectCount: pick(a, "incorrectCount") + pick(b, "incorrectCount"),
    masteryLevel: Math.max(Number(a?.masteryLevel || 0), Number(b?.masteryLevel || 0))
  };
}

// 手動統合（§15）。target に source を吸収し、source は merged にする。
export function mergeCardData(target, source, now = new Date().toISOString()) {
  const mergedTarget = {
    ...target,
    sourceSessionIds: unionStrings(target.sourceSessionIds, source.sourceSessionIds, 50),
    supplement: unionStrings(target.supplement, source.supplement),
    review: sumReview(target.review, source.review),
    createdAt: target.createdAt && source.createdAt
      ? (target.createdAt < source.createdAt ? target.createdAt : source.createdAt)
      : (target.createdAt || source.createdAt),
    updatedAt: now
  };

  const mergedSource = {
    ...source,
    status: "merged",
    mergedIntoCardId: target.cardId,
    updatedAt: now
  };

  return { target: mergedTarget, source: mergedSource };
}

// --- Phase 6: 復習 ---

export const REVIEW_RESULTS = new Set(["correct", "uncertain", "incorrect"]);

export function isReviewResult(value) {
  return REVIEW_RESULTS.has(String(value || ""));
}

// 評価から次回復習日を計算する（§16.2）。ルール変更に備え独立関数にしている。
// できた(correct)=+7日 / あやしい(uncertain)=+3日 / できなかった(incorrect)=翌日。
export function computeNextReviewDate(result, nowIso = new Date().toISOString()) {
  const offset = result === "correct" ? 7 : result === "uncertain" ? 3 : 1;
  return jstDateWithOffset(nowIso, offset);
}

// カードのreviewサブオブジェクトに評価を反映する（§16）。カード本体は変更せずreviewだけ返す。
export function applyReview(card, result, nowIso = new Date().toISOString()) {
  const prev = card?.review || {};
  const previousNextReviewDate = prev.nextReviewDate || null;
  const newNextReviewDate = computeNextReviewDate(result, nowIso);

  const num = (v) => Number(v || 0);
  const masteryLevel = result === "correct"
    ? Math.min(num(prev.masteryLevel) + 1, 5)
    : result === "incorrect"
      ? 0
      : num(prev.masteryLevel);

  const review = {
    lastReviewedAt: nowIso,
    nextReviewDate: newNextReviewDate,
    reviewCount: num(prev.reviewCount) + 1,
    correctCount: num(prev.correctCount) + (result === "correct" ? 1 : 0),
    uncertainCount: num(prev.uncertainCount) + (result === "uncertain" ? 1 : 0),
    incorrectCount: num(prev.incorrectCount) + (result === "incorrect" ? 1 : 0),
    masteryLevel
  };

  return { review, previousNextReviewDate, newNextReviewDate };
}
