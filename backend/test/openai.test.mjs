import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAnalysis } from "../lib/analysis.mjs";

test("normalizeAnalysis: unclearTranscript を {excerpt, reason} に正規化（文字列やtextも受ける・空は除外）", () => {
  const r = normalizeAnalysis({
    status: "ok",
    unclearTranscript: [
      { excerpt: "してもない者のお勤め食器の主婦処理", reason: "音声認識エラーの可能性が高い" },
      "DSE",
      { text: "ラムダ関数のデフォルトセレクター", reason: "用語を特定できない" },
      { excerpt: "", reason: "空は除外される" }
    ]
  });
  assert.equal(r.unclearTranscript.length, 3);
  assert.deepEqual(r.unclearTranscript[0], { excerpt: "してもない者のお勤め食器の主婦処理", reason: "音声認識エラーの可能性が高い" });
  assert.deepEqual(r.unclearTranscript[1], { excerpt: "DSE", reason: "" });
  assert.equal(r.unclearTranscript[2].excerpt, "ラムダ関数のデフォルトセレクター");
});

test("normalizeAnalysis: 不明瞭に入れた内容は理解/曖昧/誤解から除去（重複登録の防御）", () => {
  const r = normalizeAnalysis({
    status: "ok",
    understoodPoints: ["ECRは正しく説明できている"],
    ambiguousPoints: ["DSE"],        // excerpt と一致 → 除去
    misconceptions: ["DSE を使うと述べている"], // 不一致 → 残す
    unclearTranscript: [{ excerpt: "DSE", reason: "用語を特定できない" }]
  });
  assert.deepEqual(r.ambiguousPoints, []);
  assert.deepEqual(r.understoodPoints, ["ECRは正しく説明できている"]);
  assert.ok(r.misconceptions.includes("DSE を使うと述べている"));
});

test("normalizeAnalysis: purposeJudgement は 判定材料不足 も通す", () => {
  const r = normalizeAnalysis({ status: "ok", purposeJudgement: { status: "判定材料不足", reason: "具体的な説明がない" } });
  assert.deepEqual(r.purposeJudgement, { status: "判定材料不足", reason: "具体的な説明がない" });
});

test("normalizeAnalysis: purposeJudgement 無しは null・unclearTranscript 無しは空配列", () => {
  const r = normalizeAnalysis({ status: "ok" });
  assert.equal(r.purposeJudgement, null);
  assert.deepEqual(r.unclearTranscript, []);
  assert.deepEqual(r.understoodPoints, []);
});

test("normalizeAnalysis: エラーはそのまま返す", () => {
  const r = normalizeAnalysis({ status: "error", errorCode: "NOT_STUDY_CONTENT", message: "x" });
  assert.equal(r.status, "error");
  assert.equal(r.errorCode, "NOT_STUDY_CONTENT");
});

test("normalizeAnalysis: 不正入力は AI_INVALID_JSON", () => {
  assert.equal(normalizeAnalysis(null).errorCode, "AI_INVALID_JSON");
  assert.equal(normalizeAnalysis("x").errorCode, "AI_INVALID_JSON");
});
