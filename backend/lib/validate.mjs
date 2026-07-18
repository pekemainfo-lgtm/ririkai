export function validateCreateSessionInput(body) {
  const transcript = String(body.transcript || "").trim();
  const subject = String(body.subject || "").trim();
  const durationMinutes = body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === ""
    ? 25
    : Number(body.durationMinutes);

  if (!transcript) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "NO_TRANSCRIPT",
      message: "文字起こしがありません。"
    };
  }

  if (transcript.length < 20) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "TOO_SHORT",
      message: "文字起こしが短すぎます。"
    };
  }

  if (!subject) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "NO_SUBJECT",
      message: "分野が未入力です。"
    };
  }

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "INVALID_DURATION",
      message: "学習時間が不正です。"
    };
  }

  return { ok: true };
}
