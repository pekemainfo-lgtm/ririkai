import { test } from "node:test";
import assert from "node:assert/strict";
import { noteImageExt, noteImageKey, isOwnedNoteKey } from "../lib/keys.mjs";

test("noteImageExt は対応形式の拡張子を返す", () => {
  assert.equal(noteImageExt("image/jpeg"), "jpg");
  assert.equal(noteImageExt("image/png"), "png");
  assert.equal(noteImageExt("image/webp"), "webp");
  assert.equal(noteImageExt("image/gif"), "gif");
});

test("noteImageExt は大文字・前後空白を正規化する", () => {
  assert.equal(noteImageExt(" IMAGE/JPEG "), "jpg");
});

test("noteImageExt は未対応形式で null を返す", () => {
  assert.equal(noteImageExt("image/svg+xml"), null);
  assert.equal(noteImageExt("application/pdf"), null);
  assert.equal(noteImageExt(""), null);
  assert.equal(noteImageExt(undefined), null);
});

test("noteImageKey は日付階層と imageId でキーを組み立てる", () => {
  const key = noteImageKey("naohiro", "2026-07-18", "img123", "jpg");
  assert.equal(key, "notes/users/naohiro/2026/07/18/note_img123.jpg");
});

test("noteImageKey は ISO日時を渡しても日付部分だけ使う", () => {
  const key = noteImageKey("naohiro", "2026-07-18T05:00:00.000Z", "img123", "png");
  assert.equal(key, "notes/users/naohiro/2026/07/18/note_img123.png");
});

test("isOwnedNoteKey は自ユーザ配下のキーだけ true", () => {
  assert.equal(isOwnedNoteKey("naohiro", "notes/users/naohiro/2026/07/18/note_a.jpg"), true);
});

test("isOwnedNoteKey は他ユーザ・不正キーで false", () => {
  assert.equal(isOwnedNoteKey("naohiro", "notes/users/someone/2026/07/18/note_a.jpg"), false);
  assert.equal(isOwnedNoteKey("naohiro", "sessions/users/naohiro/x.md"), false);
  assert.equal(isOwnedNoteKey("naohiro", "../notes/users/naohiro/a.jpg"), false);
  assert.equal(isOwnedNoteKey("naohiro", ""), false);
  assert.equal(isOwnedNoteKey("naohiro", null), false);
});
