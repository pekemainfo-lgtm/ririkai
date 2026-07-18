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

// 前月・翌月への移動。month は 1-12。
export function shiftMonth(year, month, delta) {
  const zeroBased = month - 1 + delta;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
}
