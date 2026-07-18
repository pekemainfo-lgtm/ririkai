// ISO日時(UTC)を日本時間の日付(YYYY-MM-DD)に変換する。
// legacy/index.mjs の toJstDate を移植。
export function toJstDate(isoString) {
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) {
    return String(isoString || "").slice(0, 10);
  }
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
