import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { normalizeCardCandidates } from "./cards.mjs";

const REGION = "ap-northeast-1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_SECRET_ID = process.env.OPENAI_SECRET_ID || "eureka-study/openai";
const MAX_OPENAI_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 3000;
const OPENAI_TIMEOUT_MS = 120000;

const secretsClient = new SecretsManagerClient({ region: REGION });

function toStringArray(value, max = 15) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

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

function buildAnalysisPrompt(input) {
  const { subject = "", topic = "", purpose = "", notUnderstoodNote = "", transcript = "" } = input;

  const purposeInstruction = purpose
    ? `「今日の目的」が入力されています。文字起こしの内容から、目的が達成されたかを判定してください。判定は "達成" "一部達成" "未達成" "判定不能" のいずれかとし、短い理由を必ず添えてください。`
    : `「今日の目的」は未入力です。purposeJudgementはnullにしてください。`;

  return `
あなたは資格試験の学習を支援するAIです。
学習者が自分の言葉で説明した内容（文字起こし）を分析し、JSONだけを返してください。

最重要方針：
- 学習者の発言内容を正しい内容へ書き換えない。誤解があってもそのまま扱う
- 不確かな内容は断定しない
- 学習者を責めない
- JSON以外を絶対に出さない。Markdown、コードブロック、前置きは禁止

表記修正のルール：
- polishedTranscriptは、IAMやEC2のような明白な固有名詞・用語の表記揺れのみ修正する
- 意味を変える書き換え（例："CloudTrailはCPU使用率を監視する" を "CloudWatchは..." に直す）は絶対に禁止。
  誤解があれば、書き換えずにmisconceptionsに指摘として記載する

${purposeInstruction}

判定ルール：
以下の場合はエラーJSONだけを返す。
- 学習内容がほぼない
- 雑談が中心で分析できる内容がない

エラーJSON形式：
{
  "status": "error",
  "errorCode": "NOT_STUDY_CONTENT",
  "message": "学習内容として判定できませんでした。"
}

通常時は必ず次のJSON形式だけを返す。

{
  "status": "ok",
  "polishedTranscript": "表記のみ整えた文字起こし",
  "understoodPoints": ["理解できている点"],
  "ambiguousPoints": ["曖昧な点"],
  "misconceptions": ["誤解の可能性"],
  "confirmQuestions": ["確認質問"],
  "reviewItems": ["復習すべき事項"],
  "purposeJudgement": { "status": "達成", "reason": "短い理由" }
}

入力情報：
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

function normalizeAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return {
      status: "error",
      errorCode: "AI_INVALID_JSON",
      message: "AIの出力形式が不正です。"
    };
  }

  if (parsed.status === "error") {
    return {
      status: "error",
      errorCode: String(parsed.errorCode || "NOT_STUDY_CONTENT"),
      message: String(parsed.message || "学習内容として判定できませんでした。")
    };
  }

  const purposeJudgement = parsed.purposeJudgement && parsed.purposeJudgement.status
    ? {
        status: String(parsed.purposeJudgement.status || "").trim(),
        reason: String(parsed.purposeJudgement.reason || "").trim()
      }
    : null;

  return {
    status: "ok",
    polishedTranscript: String(parsed.polishedTranscript || "").trim(),
    understoodPoints: toStringArray(parsed.understoodPoints),
    ambiguousPoints: toStringArray(parsed.ambiguousPoints),
    misconceptions: toStringArray(parsed.misconceptions),
    confirmQuestions: toStringArray(parsed.confirmQuestions),
    reviewItems: toStringArray(parsed.reviewItems),
    purposeJudgement
  };
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

function buildCardsPrompt(input, analysis) {
  const { subject = "", topic = "", qualification = "", notUnderstoodNote = "", transcript = "" } = input;
  const a = analysis || {};

  const context = [
    `曖昧な点: ${(a.ambiguousPoints || []).join(" / ") || "なし"}`,
    `誤解の可能性: ${(a.misconceptions || []).join(" / ") || "なし"}`,
    `復習事項: ${(a.reviewItems || []).join(" / ") || "なし"}`,
    `自分で分からなかった点: ${notUnderstoodNote || "なし"}`
  ].join("\n");

  return `
あなたは資格試験の学習者向けに、復習用の一問一答カードを作るAIです。
学習者の文字起こしとAI分析をもとに、JSONだけを返してください。

最重要方針：
- カードを大量に作らない。1セッションにつき3〜10枚以内
- 復習価値のあるカードが3枚未満なら、無理に3枚作らない（少なくてよい）
- 優先: 曖昧な点・誤解の可能性・分からなかった点・試験で重要な条件・前提になる用語
- 学習者の誤りをそのまま正解にしない。canonicalAnswerは一般に正しい内容にする
- JSON以外を絶対に出さない。Markdown・コードブロック・前置きは禁止

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
