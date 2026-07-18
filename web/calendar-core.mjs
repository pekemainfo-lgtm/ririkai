// カレンダー表示の純ロジック。ブラウザ・Node両方から使えるようDOMやfetchに依存しない。

// year(4桁), month(1-12) から yearMonth プレフィックス "2026-07" を作る。
export function monthPrefix(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// year, month(1-12) の月グリッドを週配列で返す。
// 各週は長さ7の配列。日曜始まり。月に属さないセルは null。
// 各セルは { day, dateStr } （dateStr は "2026-07-18"）。
export function buildMonthGrid(year, month) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const startWeekday = firstDay.getUTCDay(); // 0=日
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i++) {
    cells.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({
      day,
      dateStr: `${monthPrefix(year, month)}-${String(day).padStart(2, "0")}`
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

// セッション配列を studyDate ごとに集計する。
// 返り値: { "2026-07-18": { count, totalMinutes, subjects:[], qualifications:[], sessions:[] } }
export function aggregateByDate(sessions) {
  const byDate = {};

  for (const session of sessions || []) {
    const date = session.studyDate || String(session.createdAt || "").slice(0, 10);
    if (!date) continue;

    if (!byDate[date]) {
      byDate[date] = {
        count: 0,
        totalMinutes: 0,
        subjectSet: new Set(),
        qualificationSet: new Set(),
        sessions: []
      };
    }

    const entry = byDate[date];
    entry.count += 1;
    entry.totalMinutes += Number(session.durationMinutes || 0);
    if (session.subject) entry.subjectSet.add(session.subject);
    if (session.qualification) entry.qualificationSet.add(session.qualification);
    entry.sessions.push(session);
  }

  const result = {};
  for (const [date, entry] of Object.entries(byDate)) {
    result[date] = {
      count: entry.count,
      totalMinutes: entry.totalMinutes,
      subjects: Array.from(entry.subjectSet),
      qualifications: Array.from(entry.qualificationSet),
      sessions: entry.sessions
    };
  }
  return result;
}

// ISO日時(UTC)を日本時間の日付(YYYY-MM-DD)に変換する。backend/lib/dates.mjs と同じロジックだが、
// calendar-core はブラウザからも読むため外部importを避けてここに持つ。
function toJstDate(isoString) {
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) {
    return String(isoString || "").slice(0, 10);
  }
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// カードを日付ごとに集計する（カレンダー表示用）。
// - byDate[date] = { newCards, scheduledReviews }
//   newCards: その日に採用（createdAt の JST 日付）された有効カード数（merged 除外）
//   scheduledReviews: その日が次回復習予定日の active カード数
// - dueCount: 復習予定日が today 以前の active カード数（今日の復習件数）
// - needsReviewCount: status==="needs_review" のカード数（要確認）
export function aggregateCardsByDate(cards, today) {
  const byDate = {};
  let dueCount = 0;
  let needsReviewCount = 0;

  const ensure = (date) => {
    if (!byDate[date]) byDate[date] = { newCards: 0, scheduledReviews: 0 };
    return byDate[date];
  };

  for (const card of cards || []) {
    if (!card) continue;

    if (card.status === "needs_review") {
      needsReviewCount += 1;
    }

    if (card.status === "merged") continue;

    const createdDate = toJstDate(card.createdAt);
    if (createdDate) ensure(createdDate).newCards += 1;

    const nextReviewDate = card.review && card.review.nextReviewDate;
    const mastered = card.review && card.review.mastered;
    if (card.status === "active" && !mastered && nextReviewDate) {
      ensure(nextReviewDate).scheduledReviews += 1;
      if (today && nextReviewDate <= today) dueCount += 1;
    }
  }

  return { byDate, dueCount, needsReviewCount };
}

// 前月・翌月への移動。month は 1-12。
export function shiftMonth(year, month, delta) {
  const zeroBased = month - 1 + delta;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
}
