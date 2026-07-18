// S3キー生成の純ロジック。AWS SDKに依存しないので単体テスト可能。
export function sessionMarkdownKey(userId, studyDate, sessionId) {
  // sessionId は "session_..." 形式（接頭辞込み）なので、ここでは接頭辞を付け直さない。
  const [year, month, day] = studyDate.split("-");
  return `sessions/users/${userId}/${year}/${month}/${day}/${sessionId}.md`;
}

// 許可するノート写真の形式（§8.4）。contentType→拡張子。未対応は null。
const NOTE_IMAGE_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

export function noteImageExt(contentType) {
  return NOTE_IMAGE_EXT[String(contentType || "").trim().toLowerCase()] || null;
}

// ノート写真のS3キー（§8.3）。dateIso は upload 時刻の JST 日付に丸めて使う。
// sessionId は upload 後の createSession で採番されるためキーには含めない。
export function noteImageKey(userId, dateIso, imageId, ext) {
  const [datePart] = String(dateIso).split("T");
  const [year, month, day] = String(datePart).split("-");
  return `notes/users/${userId}/${year}/${month}/${day}/note_${imageId}.${ext}`;
}

// クライアント指定のノートキーが自ユーザ配下か（§28.3：他ユーザのキーを信用しない）。
export function isOwnedNoteKey(userId, key) {
  return typeof key === "string" && key.startsWith(`notes/users/${userId}/`);
}
