import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionMarkdown, replaceNoteImagesInFrontMatter } from "../lib/markdown.mjs";

function baseSession(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: "session_test123",
    userId: "naohiro",
    studyDate: "2026-07-18",
    qualification: "AWS SOA-C03",
    subject: "Monitoring",
    topic: "CloudWatch and CloudTrail",
    durationMinutes: 25,
    status: "completed",
    createdAt: "2026-07-18T14:30:00.000Z",
    updatedAt: "2026-07-18T14:30:00.000Z",
    cardIds: [],
    noteImages: [],
    purpose: "違いを説明できるようにする",
    notUnderstoodItems: ["CloudTrailの範囲が曖昧"],
    rawTranscript: "これは生の文字起こしです。CloudTrailはCPU使用率を監視すると思う。",
    polishedTranscript: "これは表記を整えた文字起こしです。CloudTrailはCPU使用率を監視すると思う。",
    understoodPoints: ["CloudWatchがメトリクスを扱うことは理解している"],
    ambiguousPoints: ["CloudTrailとCloudWatch Logsの関係"],
    misconceptions: ["CloudTrailがCPU使用率を監視すると誤解している可能性"],
    confirmQuestions: ["CPU使用率を確認するサービスは？"],
    reviewItems: ["CloudWatch", "CloudTrail"],
    purposeJudgement: null,
    ...overrides
  };
}

test("Front Matterに主要フィールドが出力される", () => {
  const md = buildSessionMarkdown(baseSession());
  assert.match(md, /^---\n/);
  assert.match(md, /schemaVersion: 1/);
  assert.match(md, /sessionId: session_test123/);
  assert.match(md, /studyDate: 2026-07-18/);
  assert.match(md, /cardIds: \[\]/);
  assert.match(md, /noteImages: \[\]/);
});

test("Front Matterと本文にモードが出力される（未指定はinput）", () => {
  const md = buildSessionMarkdown(baseSession({ mode: "fast" }));
  assert.match(md, /mode: fast/);
  assert.match(md, /> モード: 高速周回/);
  // 未指定は input にフォールバック
  const md2 = buildSessionMarkdown(baseSession());
  assert.match(md2, /mode: input/);
  assert.match(md2, /> モード: インプット/);
});

test("生の文字起こしと表記を整えた文字起こしが両方そのまま含まれる(意味の書き換えがない)", () => {
  const session = baseSession();
  const md = buildSessionMarkdown(session);
  assert.ok(md.includes(session.rawTranscript));
  assert.ok(md.includes(session.polishedTranscript));
});

test("AI分析の各セクションが出力される", () => {
  const md = buildSessionMarkdown(baseSession());
  assert.match(md, /### 理解できている点/);
  assert.match(md, /### 曖昧な点/);
  assert.match(md, /### 誤解の可能性/);
  assert.match(md, /### 確認質問/);
  assert.match(md, /## 復習事項/);
  assert.match(md, /## 関連カード/);
});

test("purposeJudgementがある場合は達成判定セクションが出力される", () => {
  const md = buildSessionMarkdown(
    baseSession({ purposeJudgement: { status: "一部達成", reason: "違いの一部のみ説明できた" } })
  );
  assert.match(md, /### 達成判定/);
  assert.match(md, /一部達成/);
  assert.match(md, /違いの一部のみ説明できた/);
});

test("purposeJudgementがない場合は達成判定セクションを出力しない", () => {
  const md = buildSessionMarkdown(baseSession({ purposeJudgement: null }));
  assert.ok(!md.includes("### 達成判定"));
});

test("文字起こしが不明瞭な箇所セクションが excerpt — reason で出る／空は(なし)", () => {
  const md = buildSessionMarkdown(baseSession({
    unclearTranscript: [
      { excerpt: "お勤め食器の主婦処理", reason: "音声認識エラーの可能性" },
      { excerpt: "DSE", reason: "用語を特定できない" }
    ]
  }));
  assert.match(md, /## 文字起こしが不明瞭な箇所/);
  assert.ok(md.includes("- お勤め食器の主婦処理 — 音声認識エラーの可能性"));
  assert.ok(md.includes("- DSE — 用語を特定できない"));

  const md2 = buildSessionMarkdown(baseSession());
  assert.match(md2, /## 文字起こしが不明瞭な箇所\n\(なし\)/);
});

test("ノートに書き写す内容セクションとnoteText箇条書きが出力される", () => {
  const md = buildSessionMarkdown(baseSession({ noteText: ["CloudWatch=メトリクス監視", "CloudTrail=API操作の証跡"] }));
  assert.match(md, /## ノートに書き写す内容/);
  assert.ok(md.includes("- CloudWatch=メトリクス監視"));
  assert.ok(md.includes("- CloudTrail=API操作の証跡"));
});

test("replaceNoteImagesInFrontMatter: noteImagesブロックだけ差し替え、本文は保持", () => {
  const md = buildSessionMarkdown(baseSession({
    rawTranscript: "生の文字起こし本文",
    noteImages: []
  }));
  assert.match(md, /noteImages: \[\]/);
  const updated = replaceNoteImagesInFrontMatter(md, [
    "notes/users/naohiro/2026/07/18/note_a.jpg",
    "notes/users/naohiro/2026/07/18/note_b.jpg"
  ]);
  assert.ok(updated.includes("  - notes/users/naohiro/2026/07/18/note_a.jpg"));
  assert.ok(updated.includes("  - notes/users/naohiro/2026/07/18/note_b.jpg"));
  // 本文は保持
  assert.ok(updated.includes("生の文字起こし本文"));
  // front matter の他フィールドも保持
  assert.match(updated, /sessionId: session_test123/);
  // 再度差し替えても二重にならない（既存ブロックを置換）
  const again = replaceNoteImagesInFrontMatter(updated, ["notes/users/naohiro/2026/07/18/note_c.jpg"]);
  assert.ok(again.includes("note_c.jpg"));
  assert.ok(!again.includes("note_a.jpg"));
  assert.ok(!again.includes("note_b.jpg"));
});
