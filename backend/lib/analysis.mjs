// AI分析出力の正規化（純ロジック・AWS非依存でテスト可能）。
// 音声認識エラー/文脈混入対策で unclearTranscript を導入し、区分間の重複混入を防ぐ。

export function toStringArray(value, max = 15) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

// 文字起こしが不明瞭な箇所を { excerpt, reason } の配列に正規化する。
// 文字列だけ／{text,reason} で来た場合も excerpt として受ける。空 excerpt は除外。
export function toUnclearList(value, max = 15) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => {
      if (x && typeof x === "object") {
        return {
          excerpt: String(x.excerpt || x.text || "").trim(),
          reason: String(x.reason || "").trim()
        };
      }
      return { excerpt: String(x || "").trim(), reason: "" };
    })
    .filter((x) => x.excerpt)
    .slice(0, max);
}

// 比較用の正規化（空白除去・小文字化）。区分間の重複除去に使う。
export function normKey(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

export function normalizeAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return {
      status: "error",
      errorCode: "AI_INVALID_JSON",
      message: "AIの出力形式が不正です。"
    };
  }

  if (parsed.status === "error") {
    return {
      status: "error",
      errorCode: String(parsed.errorCode || "NOT_STUDY_CONTENT"),
      message: String(parsed.message || "学習内容として判定できませんでした。")
    };
  }

  const purposeJudgement = parsed.purposeJudgement && parsed.purposeJudgement.status
    ? {
        status: String(parsed.purposeJudgement.status || "").trim(),
        reason: String(parsed.purposeJudgement.reason || "").trim()
      }
    : null;

  const unclearTranscript = toUnclearList(parsed.unclearTranscript);

  // 不明瞭として分離した内容が、理解/曖昧/誤解へ重複して混入しないよう防御的に除去する
  // （区分の分離はAIの責務だが、取りこぼしをここでも防ぐ）。
  const unclearKeys = new Set(unclearTranscript.map((u) => normKey(u.excerpt)));
  const dropUnclear = (arr) => arr.filter((s) => !unclearKeys.has(normKey(s)));

  return {
    status: "ok",
    polishedTranscript: String(parsed.polishedTranscript || "").trim(),
    understoodPoints: dropUnclear(toStringArray(parsed.understoodPoints)),
    ambiguousPoints: dropUnclear(toStringArray(parsed.ambiguousPoints)),
    misconceptions: dropUnclear(toStringArray(parsed.misconceptions)),
    unclearTranscript,
    confirmQuestions: toStringArray(parsed.confirmQuestions),
    reviewItems: toStringArray(parsed.reviewItems),
    noteText: toStringArray(parsed.noteText),
    purposeJudgement
  };
}
