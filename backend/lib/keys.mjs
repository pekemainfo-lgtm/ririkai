// S3キー生成の純ロジック。AWS SDKに依存しないので単体テスト可能。
export function sessionMarkdownKey(userId, studyDate, sessionId) {
  // sessionId は "session_..." 形式（接頭辞込み）なので、ここでは接頭辞を付け直さない。
  const [year, month, day] = studyDate.split("-");
  return `sessions/users/${userId}/${year}/${month}/${day}/${sessionId}.md`;
}
