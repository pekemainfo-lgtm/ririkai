import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCreateSessionInput } from "../lib/validate.mjs";

test("正常な入力はokになる", () => {
  const result = validateCreateSessionInput({
    transcript: "a".repeat(30),
    subject: "AWS",
    durationMinutes: 25
  });
  assert.equal(result.ok, true);
});

test("transcriptが空だとNO_TRANSCRIPT", () => {
  const result = validateCreateSessionInput({ subject: "AWS", durationMinutes: 25 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "NO_TRANSCRIPT");
});

test("transcriptが短すぎるとTOO_SHORT", () => {
  const result = validateCreateSessionInput({ transcript: "short", subject: "AWS", durationMinutes: 25 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "TOO_SHORT");
});

test("subjectが空だとNO_SUBJECT", () => {
  const result = validateCreateSessionInput({ transcript: "a".repeat(30), durationMinutes: 25 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "NO_SUBJECT");
});

test("durationMinutesが0以下だとINVALID_DURATION", () => {
  const result = validateCreateSessionInput({ transcript: "a".repeat(30), subject: "AWS", durationMinutes: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "INVALID_DURATION");
});

test("mode未指定はok（下流でinput既定）", () => {
  const result = validateCreateSessionInput({ transcript: "a".repeat(30), subject: "AWS", durationMinutes: 25 });
  assert.equal(result.ok, true);
});

test("mode=input/practice/fastはok", () => {
  for (const mode of ["input", "practice", "fast"]) {
    const result = validateCreateSessionInput({ transcript: "a".repeat(30), subject: "AWS", durationMinutes: 25, mode });
    assert.equal(result.ok, true, `mode=${mode} should be ok`);
  }
});

test("不正なmodeはINVALID_MODEで拒否", () => {
  const result = validateCreateSessionInput({ transcript: "a".repeat(30), subject: "AWS", durationMinutes: 25, mode: "turbo" });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.errorCode, "INVALID_MODE");
});
