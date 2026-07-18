import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionMarkdownKey } from "../lib/keys.mjs";

test("MarkdownのS3キーが日付階層とsessionIdで組み立てられる", () => {
  const key = sessionMarkdownKey("naohiro", "2026-07-18", "session_abc123");
  assert.equal(key, "sessions/users/naohiro/2026/07/18/session_abc123.md");
});

test("sessionIdの接頭辞が二重にならない", () => {
  const key = sessionMarkdownKey("naohiro", "2026-07-18", "session_abc123");
  assert.ok(!key.includes("session_session_"));
});
