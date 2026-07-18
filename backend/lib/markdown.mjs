function yamlScalar(value) {
  const s = String(value ?? "");
  if (s === "") return '""';
  const needsQuote = /[:#\-{}\[\],&*!|>'"%@`\n]/.test(s) || /^\s|\s$/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlList(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return " []";
  return "\n" + list.map((item) => `  - ${yamlScalar(item)}`).join("\n");
}

function frontMatter(session) {
  const lines = [
    "---",
    `schemaVersion: ${session.schemaVersion}`,
    `sessionId: ${yamlScalar(session.sessionId)}`,
    `userId: ${yamlScalar(session.userId)}`,
    `studyDate: ${session.studyDate}`,
    `mode: ${yamlScalar(session.mode || "input")}`,
    `qualification: ${yamlScalar(session.qualification)}`,
    `subject: ${yamlScalar(session.subject)}`,
    `topic: ${yamlScalar(session.topic)}`,
    `durationMinutes: ${session.durationMinutes}`,
    `status: ${session.status}`,
    `createdAt: ${session.createdAt}`,
    `updatedAt: ${session.updatedAt}`,
    `cardIds:${yamlList(session.cardIds)}`,
    `noteImages:${yamlList(session.noteImages)}`,
    "---"
  ];
  return lines.join("\n");
}

const MODE_LABELS = {
  input: "インプット（頭に入れる段階）",
  practice: "演習（初回〜数回）",
  fast: "高速周回（最後の詰め）"
};

function modeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.input;
}

function bulletList(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "(なし)";
  return list.map((item) => `- ${item}`).join("\n");
}

function numberedList(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "(なし)";
  return list.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

// §4.3/4.4 のFront Matter・本文構成に沿ってMarkdownを組み立てる。
// カード(関連カード)はPhase 4以降で追加するため、Phase 2では空のまま出力する。
export function buildSessionMarkdown(session) {
  const purposeSection = session.purposeJudgement
    ? `## 今日の目的\n${session.purpose || "(未入力)"}\n\n### 達成判定\n${session.purposeJudgement.status}\n${session.purposeJudgement.reason}\n`
    : `## 今日の目的\n${session.purpose || "(未入力)"}\n`;

  const body = [
    `# ${session.topic || session.subject}`,
    "",
    `> モード: ${modeLabel(session.mode)}`,
    "",
    purposeSection,
    "## 自分で分からなかった点",
    bulletList(session.notUnderstoodItems),
    "",
    "## 生の文字起こし",
    session.rawTranscript || "",
    "",
    "## 表記を整えた文字起こし",
    session.polishedTranscript || session.rawTranscript || "",
    "",
    "## AI分析",
    "### 理解できている点",
    bulletList(session.understoodPoints),
    "",
    "### 曖昧な点",
    bulletList(session.ambiguousPoints),
    "",
    "### 誤解の可能性",
    bulletList(session.misconceptions),
    "",
    "### 確認質問",
    numberedList(session.confirmQuestions),
    "",
    "## 復習事項",
    bulletList(session.reviewItems),
    "",
    "## ノートに書き写す内容",
    bulletList(session.noteText),
    "",
    "## 関連カード",
    "(なし)"
  ].join("\n");

  return `${frontMatter(session)}\n\n${body}\n`;
}

// 既存Markdownの front matter 内の noteImages ブロックだけを差し替える（本文は触らない）。
// 後付けの写真添付でMarkdownの写真参照を正本に反映するために使う（§23.2）。
export function replaceNoteImagesInFrontMatter(markdown, keys) {
  const text = String(markdown || "");
  if (!text.startsWith("---")) return text;

  // 2つ目の "---"（front matter の終端）を探す。
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;

  const head = text.slice(0, end); // front matter 本体（先頭の "---" を含む）
  const rest = text.slice(end);     // "\n---" 以降（本文）

  const newNoteImages = `noteImages:${yamlList(keys)}`;
  // 既存の "noteImages:" 行とそのリスト項目（"  - ..."）を置換。無ければ末尾に追記。
  const noteImagesRe = /noteImages:(?: \[\]|(?:\n {2}- .*)*)/;
  const newHead = noteImagesRe.test(head)
    ? head.replace(noteImagesRe, newNoteImages)
    : `${head}\n${newNoteImages}`;

  return `${newHead}${rest}`;
}
