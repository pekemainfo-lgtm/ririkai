import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { normalizeCardCandidates, sanitizeStudyMode } from "./cards.mjs";
import { normalizeAnalysis } from "./analysis.mjs";

const REGION = "ap-northeast-1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_SECRET_ID = process.env.OPENAI_SECRET_ID || "eureka-study/openai";
const MAX_OPENAI_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 3000;
const OPENAI_TIMEOUT_MS = 120000;

const secretsClient = new SecretsManagerClient({ region: REGION });

async function getOpenAIApiKey() {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: OPENAI_SECRET_ID })
  );

  if (!response.SecretString) {
    throw new Error("SecretString is empty");
  }

  let secret;
  try {
    secret = JSON.parse(response.SecretString);
  } catch {
    secret = { OPENAI_API_KEY: response.SecretString };
  }

  if (!secret.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not found in secret");
  }

  return secret.OPENAI_API_KEY;
}

// 学習モードの日本語ラベル。プロンプト・Markdown・UIで共用の意図。
const MODE_LABELS = {
  input: "インプット（頭に入れる段階）",
  practice: "演習（初回〜数回）",
  fast: "高速周回（最後の詰め）"
};

export function studyModeLabel(mode) {
  return MODE_LABELS[sanitizeStudyMode(mode)];
}

// モードごとに分析の力点を変える指示（§Phase 9）。
// 注意：noteText は「今回の修正点だけ」という下記の共通ルールが常に優先。モードで件数を水増ししない。
function analysisModeInstruction(mode) {
  if (mode === "practice") {
    return `学習モードは「演習（初回〜数回）」です。分からない点・つまずきを手厚く扱ってください。ambiguousPoints・misconceptions・confirmQuestions を重点的に厚く出し、知識の適用・条件・違いを掘り下げてください。noteText は今回つまずいた/誤解した点の修正に絞る（理解できていた内容は入れない）。`;
  }
  if (mode === "fast") {
    return `学習モードは「高速周回（最後の詰め）」です。覚えるべき点は概ね把握できている前提で、簡潔にしてください。注意点・弱点・間違えやすい点だけを短くまとめ、冗長な説明は避ける。noteText は今回残った弱点だけに絞る。`;
  }
  return `学習モードは「インプット（頭に入れる段階）」です。基礎・定義・仕組みを体系的に整理する視点で分析してください。ただし noteText は「今回つまずいた/曖昧だった/誤解した基礎」だけに絞り、既に理解できている基礎や一般的な教科書項目は再掲しないでください。`;
}

function buildAnalysisPrompt(input) {
  const { subject = "", topic = "", purpose = "", notUnderstoodNote = "", transcript = "" } = input;
  const mode = sanitizeStudyMode(input.mode);

  const purposeInstruction = purpose
    ? `「今日の目的」が入力されています。文字起こしに実際に含まれる内容だけを根拠に、目的の達成度を "達成" "一部達成" "未達成" "判定材料不足" のいずれかで判定し、短い理由を添えてください。理由には入力に存在する内容だけを使い、入力にないサービス名・論点を持ち込まないこと。判定の指針：学習者がトピック名を挙げるだけ・「一通り見た」「よくわからない」等で、目的に対して自分の言葉で説明できている具体的内容が入力に無い場合は、"未達成" ではなく "判定材料不足"（評価できる説明が無い）とする。理解や誤りを判断できる具体的な説明がある時だけ 達成/一部達成/未達成 を選ぶ。`
    : `「今日の目的」は未入力です。purposeJudgementはnullにしてください。`;

  return `
あなたは資格試験の学習を支援するAIです。
学習者が自分の言葉で説明した内容（音声認識による文字起こし）を分析し、JSONだけを返してください。
文字起こしには音声認識エラー（意味の通らない語・聞き間違い）が混ざりうる前提で扱ってください。

最重要方針：
- 学習者の発言内容を正しい内容へ書き換えない。誤解があってもそのまま扱う
- 不確かな内容は断定しない。確信が高くない判断は「確認が必要」または「文字起こし不明瞭」に回す
- 学習者を責めない
- JSON以外を絶対に出さない。Markdown、コードブロック、前置きは禁止

音声認識エラー・不明瞭・用語不明の扱い（最重要）：
- 意味が通らない文字列を推測して補完しない。無理に解釈しない
- 文章として成立していない箇所は、学習者の理解不足や誤解として扱わず、unclearTranscript（文字起こしが不明瞭な箇所）に分離する
- 意味を高い確度で特定できない用語（例：文脈に合わない語、実在を確認できない用語）は、既存のAWSサービス名や一般概念に無理やり変換しない。unclearTranscript に「用語を特定できない」として入れる。候補が思いつく場合も断定せず「○○の聞き間違いの可能性」と表現する
- unclearTranscript に入れた内容は、understoodPoints / ambiguousPoints / misconceptions / confirmQuestions / reviewItems / noteText のいずれにも使わない

各区分の定義（重複させない。1つの内容は最も適切な1区分だけに入れる）：
- understoodPoints：意味が明確で、内容もおおむね正しい発言だけ
- ambiguousPoints：学習者自身の説明が曖昧だが、文章としては成立しているもの。文字起こしエラーはここに混ぜない
- misconceptions：次をすべて満たす時だけ。①発言内容が明確 ②学習者の主張を特定できる ③技術的に誤っている可能性が高い ④単なる音声認識エラーではない。断定できない場合は misconceptions に入れず、confirmQuestions に「確認が必要」として回す
- unclearTranscript：音声認識エラーの可能性が高い箇所、または意味を特定できない用語。excerpt に元の該当箇所、reason に理由（例「音声認識エラーの可能性が高く内容を評価できません」「AWS用語として意味を特定できません」「用語を特定できないため元の発言を確認してください」）

文脈混入の禁止：
- 判断材料は「入力された文字起こし・今回の学習テーマ・自分で分からなかった点」だけ。ここに無い論点・AWSサービス名・話題を生成しない
- 過去の別セッションや一般論から、今回の発言に無いトピックを持ち込まない

表記修正のルール：
- polishedTranscriptは、IAMやEC2のような明白な固有名詞・用語の表記揺れのみ修正する
- 意味を変える書き換えは禁止（誤解は書き換えず misconceptions に指摘）。意味不明な箇所は無理に直さずそのまま残す

confirmQuestions（確認質問）の優先順位：
1. 明確な誤解を修正する質問
2. 学習者が曖昧に説明した内容を、自力で説明させる質問
3. 今回の学習テーマの中心事項を確認する質問
- 文字起こしエラーや意味を特定できない用語について、知識問題を作らない（例「○○とは何ですか？」は禁止）。必要なら「『○○』と文字起こしされていますが、元の用語を確認してください」という音声再確認の案内にとどめる（知識確認ではない）

reviewItems（復習事項）のルール：
- 今回の発言から確認された弱点（誤解・説明できなかった重要点・混同）だけに絞る
- 教科書的な一般項目を広く並べない。今回理解できていた内容は入れない
- 不明瞭・用語不明の箇所からは作らない

noteText（ノートに書き写す内容）のルール：
- 「今回の修正点」だけを書く：明確に誤解していた内容／説明できなかった重要事項／混同していた概念／次までに覚え直す短い修正点
- 理解できている内容・一般的な教科書項目は入れない（今回の弱点でない一般論は禁止）
- 件数は今回の弱点の数だけにする。埋めるために一般論を足さない（目安0〜5個、該当が無ければ空配列）
- 1項目は1行の短い修正メモにする
- 学習者が今回すべて正しく説明できていた場合は、noteText は空配列にする

${analysisModeInstruction(mode)}

${purposeInstruction}

判定ルール：
以下の場合はエラーJSONだけを返す。
- 学習内容がほぼない
- 雑談が中心で分析できる内容がない
- 文字起こしの大半が意味をなさず、評価できる学習内容が無い

エラーJSON形式：
{
  "status": "error",
  "errorCode": "NOT_STUDY_CONTENT",
  "message": "学習内容として判定できませんでした。"
}

通常時は必ず次のJSON形式だけを返す（不明瞭で該当が無い配列は空配列にする）。

{
  "status": "ok",
  "polishedTranscript": "表記のみ整えた文字起こし",
  "understoodPoints": ["理解できている点"],
  "ambiguousPoints": ["曖昧な点"],
  "misconceptions": ["誤解の可能性"],
  "unclearTranscript": [ { "excerpt": "文字起こしの不明瞭な該当箇所", "reason": "音声認識エラーの可能性/用語を特定できない 等" } ],
  "confirmQuestions": ["確認質問"],
  "reviewItems": ["今回確認された弱点に絞った復習事項"],
  "noteText": ["今回の修正点だけの短い箇条書き"],
  "purposeJudgement": { "status": "達成 | 一部達成 | 未達成 | 判定材料不足", "reason": "入力にある内容だけを根拠にした短い理由" }
}

入力情報：
学習モード: ${MODE_LABELS[mode]}
分野: ${subject}
テーマ: ${topic || "未指定"}
今日の目的: ${purpose || "なし"}
自分で分からなかった点: ${notUnderstoodNote || "なし"}

文字起こし：
${transcript}
`;
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((item) => item.content || [])
      .map((content) => content.text || "")
      .join("\n")
      .trim();
  }

  return "";
}

function extractJsonText(text) {
  if (!text) {
    throw new Error("AI_EMPTY_RESPONSE");
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return text.slice(first, last + 1).trim();
  }

  return text.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// OpenAI Responses APIにJSON応答を要求し、パース済みオブジェクトを返す低レベル関数。
// 分析・カード生成の両方から使う。
async function requestOpenAIJson(apiKey, systemContent, prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: systemContent },
          { role: "user", content: prompt }
        ],
        text: {
          format: { type: "json_object" }
        },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      const e = new Error(`OpenAI API error: ${response.status} ${errorText}`);
      e.errorCode = "AI_API_ERROR";
      e.statusCode = response.status;
      throw e;
    }

    const data = await response.json();
    const outputText = extractResponseText(data);
    const jsonText = extractJsonText(outputText);

    try {
      return JSON.parse(jsonText);
    } catch (e) {
      e.errorCode = "AI_INVALID_JSON";
      throw e;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      const e = new Error("OpenAI request timed out");
      e.errorCode = "AI_TIMEOUT";
      throw e;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAIOnce(apiKey, prompt) {
  const parsed = await requestOpenAIJson(
    apiKey,
    "あなたは学習内容をJSONに整理する専門AIです。必ずJSONだけを返してください。",
    prompt
  );
  return normalizeAnalysis(parsed);
}

export async function callOpenAIForAnalysis(input) {
  const apiKey = await getOpenAIApiKey();
  const prompt = buildAnalysisPrompt(input);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_OPENAI_ATTEMPTS; attempt++) {
    try {
      const result = await callOpenAIOnce(apiKey, prompt);
      if (!result?.status) {
        const e = new Error("AI result does not have status");
        e.errorCode = "AI_INVALID_JSON";
        throw e;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_OPENAI_ATTEMPTS) {
        await sleep(800 * attempt);
      }
    }
  }

  const e = new Error(lastError?.message || "AI retry failed");
  e.errorCode = lastError?.errorCode || "AI_RETRY_FAILED";
  e.statusCode = lastError?.statusCode;
  throw e;
}

// モードごとにカードの狙いを変える指示（§Phase 9）。
function cardsModeInstruction(mode) {
  if (mode === "practice") {
    return `学習モードは「演習」です。分からなかった点・曖昧な点・誤解の可能性を優先し、知識の適用・条件・違い（difference/condition/comparison）を問うカードを厚めに作ってください。`;
  }
  if (mode === "fast") {
    return `学習モードは「高速周回（最後の詰め）」です。新規カードは最小限にし、間違えやすい注意点・弱点（misconception/condition）だけに絞ってください。既に分かりきった基礎の定義カードは作らない。`;
  }
  return `学習モードは「インプット」です。基礎・定義・仕組み（definition/component/cause_effect）を中心に、後で土台となるカードを作ってください。`;
}

function buildCardsPrompt(input, analysis) {
  const { subject = "", topic = "", qualification = "", notUnderstoodNote = "", transcript = "" } = input;
  const mode = sanitizeStudyMode(input.mode);
  const a = analysis || {};

  const unclear = (a.unclearTranscript || [])
    .map((u) => (u && typeof u === "object" ? u.excerpt : String(u || "")))
    .filter(Boolean);

  const context = [
    `曖昧な点: ${(a.ambiguousPoints || []).join(" / ") || "なし"}`,
    `誤解の可能性: ${(a.misconceptions || []).join(" / ") || "なし"}`,
    `復習事項: ${(a.reviewItems || []).join(" / ") || "なし"}`,
    `自分で分からなかった点: ${notUnderstoodNote || "なし"}`,
    `文字起こしが不明瞭な箇所（カード化しない）: ${unclear.join(" / ") || "なし"}`
  ].join("\n");

  return `
あなたは資格試験の学習者向けに、復習用の一問一答カードを作るAIです。
学習者の文字起こしとAI分析をもとに、JSONだけを返してください。

最重要方針：
- カードを大量に作らない。1セッションにつき3〜10枚以内
- 復習価値のあるカードが3枚未満なら、無理に3枚作らない（少なくてよい・0枚でもよい）
- 優先: 今回確認された弱点（誤解・曖昧な点・分からなかった点）。今回理解できていた内容はカード化しない
- 学習者の誤りをそのまま正解にしない。canonicalAnswerは一般に正しい内容にする
- 意味の通らない文・音声認識エラーの疑いがある箇所（「文字起こしが不明瞭な箇所」）からはカードを作らない
- 意味を高い確度で特定できない用語からカードを作らない。既存のAWSサービス名や一般概念に無理やり変換しない。断定できない用語はカード化しない
- 入力の文字起こし・テーマ・分析に無いサービス名・論点を作らない（文脈混入の禁止）
- JSON以外を絶対に出さない。Markdown・コードブロック・前置きは禁止

${cardsModeInstruction(mode)}

各カードの作り方：
- question: 短い一問一答の問い
- canonicalAnswer: 短く、単独で意味が通じる正解（詳細条件は入れない）
- supplement: 詳細条件・注意点を配列で分ける（0〜5個）
- cardType: 次のいずれか
  definition(定義) / difference(違い) / condition(条件) / procedure(手順) /
  cause_effect(原因と結果) / component(構成要素) / example(具体例) /
  misconception(誤解しやすい点) / comparison(比較)
- conceptKey: 概念を識別する短いキー。"分野:用語" 形式（例 aws:nat-gateway, linux:inode）。
  同じ用語でも問う知識が違えば別キーにしてよい（例 aws:nat-gateway-placement）
- reason: そのカードを作る理由（短く）

出力JSON形式（cardsが空でもよい）：
{
  "status": "ok",
  "cards": [
    {
      "cardType": "definition",
      "conceptKey": "aws:nat-gateway",
      "question": "NAT Gatewayとは？",
      "canonicalAnswer": "プライベートサブネットのリソースが外部からの着信を受けずに外向き通信するためのマネージドサービス。",
      "supplement": ["パブリックサブネットに配置する", "Elastic IPを関連付ける"],
      "reason": "定義が曖昧だったため"
    }
  ]
}

学習モード: ${MODE_LABELS[mode]}
資格・コース: ${qualification || "未指定"}
分野: ${subject}
テーマ: ${topic || "未指定"}

AI分析の要点：
${context}

文字起こし：
${transcript}
`;
}

// カード候補を生成する。学習材料が乏しい場合は cards:[] を返す。
export async function callOpenAIForCards(input, analysis) {
  const apiKey = await getOpenAIApiKey();
  const prompt = buildCardsPrompt(input, analysis);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_OPENAI_ATTEMPTS; attempt++) {
    try {
      const parsed = await requestOpenAIJson(
        apiKey,
        "あなたは学習カードをJSONで作る専門AIです。必ずJSONだけを返してください。",
        prompt
      );
      return { status: "ok", cards: normalizeCardCandidates(parsed?.cards) };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_OPENAI_ATTEMPTS) {
        await sleep(800 * attempt);
      }
    }
  }

  const e = new Error(lastError?.message || "card generation failed");
  e.errorCode = lastError?.errorCode || "CARD_GEN_FAILED";
  throw e;
}
