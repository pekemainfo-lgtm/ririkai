import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = "ap-northeast-1";
const SECRET_ID = "eureka-study/openai";
const TABLE_NAME = "StudyLogTable";

const USER_ID = "naohiro";

// 写真添付用S3バケット。Lambda環境変数 ATTACHMENTS_BUCKET に作成したバケット名を設定する。
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET || "";

// アップロードURL・閲覧URLの有効期限(秒)
const UPLOAD_URL_EXPIRES_SEC = 300;
const VIEW_URL_EXPIRES_SEC = 900;

// 添付は1セッションあたり最大枚数
const MAX_ATTACHMENTS = 10;

// AIログ生成時に「写真の文字も読ませる」枚数の上限。コスト・処理時間の保険。
const MAX_VISION_IMAGES = 6;

// しっかり回答優先。必要ならLambda環境変数 OPENAI_MODEL で gpt-4.1-mini 等に変更可能。
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

// 非同期処理なので、出力はしっかり出してよい。
const MAX_OPENAI_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 5000;

// 25分ログ想定。長すぎる場合はDynamoDB制限対策でカット。
const MAX_TRANSCRIPT_CHARS = 20000;

// Lambdaタイムアウト3分前提。OpenAI処理は最大120秒まで待つ。
const OPENAI_TIMEOUT_MS = 120000;

const secretsClient = new SecretsManagerClient({ region: REGION });
const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const lambdaClient = new LambdaClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      "Access-Control-Max-Age": "86400"
    },
    body: JSON.stringify(data)
  };
}

function parseBody(event) {
  if (!event) return {};

  if (!event.body) return event;

  if (typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch (error) {
      const e = new Error("Request body is not valid JSON");
      e.errorCode = "INVALID_REQUEST_JSON";
      throw e;
    }
  }

  return event.body;
}

function sanitizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-ぁ-んァ-ヶ一-龠ー]/g, "")
    .slice(0, 80);
}

function toStringArray(value, max = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function createJobId() {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 10);
  return `JOB#${now}#${rand}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ISO日時(UTC)を日本時間の日付(YYYY-MM-DD)に変換する。
// 旧実装は createdAt.slice(0, 10) だったため、JSTの朝9時前の学習が前日扱いになっていた。
function toJstDate(isoString) {
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) {
    return String(isoString || "").slice(0, 10);
  }
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function trimTranscriptForStorage(transcript) {
  const text = String(transcript || "").trim();

  if (text.length <= MAX_TRANSCRIPT_CHARS) {
    return {
      transcript: text,
      originalTranscriptChars: text.length,
      transcriptChars: text.length,
      transcriptTruncated: false
    };
  }

  return {
    transcript: text.slice(0, MAX_TRANSCRIPT_CHARS),
    originalTranscriptChars: text.length,
    transcriptChars: MAX_TRANSCRIPT_CHARS,
    transcriptTruncated: true
  };
}

function publicInput(input) {
  return {
    exam: input.exam || "",
    subject: input.subject,
    unit: input.unit,
    mode: input.mode,
    durationMinutes: input.durationMinutes,
    memo: input.memo || "",
    transcriptChars: input.transcriptChars || String(input.transcript || "").length,
    originalTranscriptChars: input.originalTranscriptChars || String(input.transcript || "").length,
    transcriptTruncated: !!input.transcriptTruncated
  };
}

function validateGenerateInput(body) {
  const transcript = String(body.transcript || "").trim();
  const subject = String(body.subject || "").trim();
  const durationMinutes = Number(body.durationMinutes || 25);

  if (!transcript) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "NO_RECORDING",
      message: "録音内容がありません。"
    };
  }

  if (transcript.length < 20) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "TOO_SHORT",
      message: "録音内容が短すぎます。"
    };
  }

  if (!subject) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "NO_SUBJECT",
      message: "科目が未入力です。"
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

async function getOpenAIApiKey() {
  const command = new GetSecretValueCommand({
    SecretId: SECRET_ID
  });

  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error("SecretString is empty");
  }

  let secret;

  try {
    secret = JSON.parse(response.SecretString);
  } catch {
    secret = {
      OPENAI_API_KEY: response.SecretString
    };
  }

  if (!secret.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not found in secret");
  }

  return secret.OPENAI_API_KEY;
}

function buildPrompt(input) {
  const {
    subject = "",
    unit = "",
    mode = "practice",
    durationMinutes = 25,
    transcript = "",
    memo = "",
    transcriptTruncated = false,
    originalTranscriptChars = 0,
    attachments = []
  } = input;

  const photoCount = Array.isArray(attachments) ? attachments.length : 0;
  const photoNote = photoCount
    ? `写真が${photoCount}枚添付されています。写真内の文字(問題文・ノート・スクショ・図表など)も読み取り、文字起こしと合わせて学習内容として扱ってください。写真から拾った重要な用語・数字・コマンド・例外も、復習カードや要点に反映してください。`
    : "写真の添付はありません。";

  const modeInstruction = {
    input: "インプット中心。今日入れた知識、用語、要点、曖昧な概念を優先して整理する。",
    practice: "演習中心。間違えた問題、迷った選択肢、説明できない内容、読み落としを優先して整理する。",
    free: "自由学習。考えていたテーマ、気づき、未解決の問い、あとで整理したい内容を優先して整理する。"
  }[mode] || "学習ログ整理として処理する。";

  const truncatedNote = transcriptTruncated
    ? `文字起こしは長すぎるため、先頭${MAX_TRANSCRIPT_CHARS}文字のみ使用。元文字数は${originalTranscriptChars}文字。`
    : "文字起こしは全文使用。";

  return `
あなたは資格試験の学習ログ作成AIです。
ユーザーの学習発話から、あとで復習できる学習ログをJSONだけで作成してください。

最重要方針：
- 速さより、復習に使える質を優先する
- ただし冗長な長文は禁止
- ユーザーの発話から、試験で落としやすい混同・用語・コマンド・数字・例外を拾う
- 「わかったつもり」を潰すカードを作る
- ユーザーを責めない
- 不確かな内容は断定せず「要確認」と書く
- JSON以外を絶対に出さない
- Markdown、コードブロック、前置き、解説文は禁止

対象：
LinuC、AWS、CCNA、行政書士などの択一式試験。

モード：
${mode}
${modeInstruction}

入力情報：
科目: ${subject}
単元: ${unit || "未指定"}
学習時間: ${durationMinutes}分
補足メモ: ${memo || "なし"}
文字起こし処理: ${truncatedNote}
写真: ${photoNote}

文字起こし：
${transcript}

判定ルール：
以下の場合はエラーJSONだけを返す。
- 学習内容がほぼない
- 雑談が中心
- 科目と内容が大きく違う
- 情報が少なすぎて学習ログにできない

エラーJSON形式：
{
  "status": "error",
  "errorCode": "NOT_STUDY_CONTENT",
  "message": "学習内容として判定できませんでした。"
}

通常時は必ず次のJSON形式だけを返す。

{
  "status": "ok",
  "summary": [
    "学習内容全体の短いまとめ"
  ],
  "checkPoints": [
    "あとで確認するとよい内容"
  ],
  "explanations": [
    {
      "title": "用語またはテーマ",
      "shortExplanation": "1〜3行の簡易解説",
      "memoryTip": "短い覚え方",
      "deepDiveMemo": {
        "topic": "整理したいテーマ",
        "points": [
          "何と何の違いを押さえるべきか",
          "どういう場面で使うのか",
          "試験で問われやすいポイント"
        ]
      }
    }
  ],
  "visibleCards": [
    {
      "question": "学習直後に表示する問題",
      "answer": "短い答え",
      "reason": "表示する理由"
    }
  ],
  "savedCards": [
    {
      "question": "復習用の問題",
      "answer": "短い答え",
      "category": "基本確認"
    }
  ],
  "noteText": [
    "紙のノートに写す短い内容"
  ]
}

作成ルール：
- summary は4〜7個
- checkPoints は5〜10個
- explanations は4〜8個
- visibleCards は5〜8枚
- savedCards は12〜20枚
- noteText は5〜10個
- visibleCards に出したカードは savedCards にも含める
- savedCards には、基本確認・混同注意・試験対策をバランスよく含める
- 1枚のカードは短く、一問一答にする
- コマンド、オプション、数字、ファイル名、違い、例外を優先する
- shortExplanation は短いが、試験で使える具体性を持たせる
- memoryTip は無理に語呂にしなくてよい。覚え方・見分け方でもよい
- noteText は紙にそのまま写せる短い箇条書きにする
- 「次にやること」は出さない
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

function normalizeCard(card, fallbackCategory = "基本確認") {
  return {
    question: String(card?.question || card?.front || "").trim(),
    answer: String(card?.answer || card?.back || "").trim(),
    category: String(card?.category || fallbackCategory).trim() || fallbackCategory,
    reason: String(card?.reason || "").trim()
  };
}

function normalizeStudyLog(log) {
  if (!log || typeof log !== "object") {
    return {
      status: "error",
      errorCode: "AI_INVALID_JSON",
      message: "AIの出力形式が不正です。"
    };
  }

  if (log.status === "error") {
    return {
      status: "error",
      errorCode: String(log.errorCode || "NOT_STUDY_CONTENT"),
      message: String(log.message || "学習内容として判定できませんでした。")
    };
  }

  const summary = toStringArray(
    Array.isArray(log.summary) ? log.summary : [log.summary].filter(Boolean),
    7
  );

  const checkPoints = toStringArray(
    Array.isArray(log.checkPoints)
      ? log.checkPoints
      : Array.isArray(log.weakPoints)
        ? log.weakPoints.map((wp) => wp.label || wp.key || wp.reason)
        : [],
    10
  );

  const explanations = Array.isArray(log.explanations)
    ? log.explanations.slice(0, 8).map((item) => ({
        title: String(item?.title || "").trim(),
        shortExplanation: String(item?.shortExplanation || item?.explanation || "").trim(),
        memoryTip: String(item?.memoryTip || "").trim(),
        deepDiveMemo: {
          topic: String(item?.deepDiveMemo?.topic || item?.title || "").trim(),
          points: toStringArray(item?.deepDiveMemo?.points || [], 5)
        }
      })).filter((item) => item.title || item.shortExplanation)
    : [];

  if (explanations.length === 0 && Array.isArray(log.weakPointExplanations)) {
    for (const item of log.weakPointExplanations.slice(0, 8)) {
      explanations.push({
        title: String(item?.label || item?.key || "").trim(),
        shortExplanation: String(item?.explanation || "").trim(),
        memoryTip: String(item?.example || "").trim(),
        deepDiveMemo: {
          topic: String(item?.label || item?.key || "").trim(),
          points: [
            "何と何の違いを押さえるべきか",
            "どういう場面で使うのか",
            "試験で問われやすいポイント"
          ]
        }
      });
    }
  }

  const visibleCards = (Array.isArray(log.visibleCards) ? log.visibleCards : log.flashcards || [])
    .slice(0, 8)
    .map((card) => normalizeCard(card, "要確認"))
    .filter((card) => card.question && card.answer);

  let savedCards = (Array.isArray(log.savedCards) ? log.savedCards : log.flashcards || [])
    .slice(0, 20)
    .map((card) => normalizeCard(card, "基本確認"))
    .filter((card) => card.question && card.answer);

  const savedKeySet = new Set(savedCards.map((card) => `${card.question}||${card.answer}`));
  for (const card of visibleCards) {
    const key = `${card.question}||${card.answer}`;
    if (!savedKeySet.has(key)) {
      savedCards.push({
        question: card.question,
        answer: card.answer,
        category: card.category || "要確認",
        reason: card.reason || ""
      });
      savedKeySet.add(key);
    }
  }
  savedCards = savedCards.slice(0, 20);

  const noteText = toStringArray(
    Array.isArray(log.noteText)
      ? log.noteText
      : String(log.noteSummary || "")
          .split(/\n+/)
          .map((x) => x.replace(/^[-・\s]+/, "").trim())
          .filter(Boolean),
    10
  );

  const weakPoints = checkPoints.slice(0, 10).map((label, index) => ({
    key: sanitizeKey(label || `checkpoint-${index + 1}`),
    label,
    reason: "あとで確認するとよい内容",
    severity: index < 3 ? "medium" : "low"
  }));

  const weakPointExplanations = explanations.slice(0, 10).map((ex) => ({
    key: sanitizeKey(ex.title || "explanation"),
    label: ex.title || "要確認",
    explanation: ex.shortExplanation || "",
    example: ex.memoryTip || ""
  }));

  const flashcards = visibleCards.slice(0, 8).map((card) => ({
    front: card.question,
    back: card.answer
  }));

  return {
    status: "ok",
    summary,
    checkPoints,
    explanations,
    visibleCards,
    savedCards,
    noteText,

    // 旧形式互換
    mainStuckPoint: checkPoints[0] || "",
    understoodPoints: summary,
    weakPoints,
    weakPointExplanations,
    explainCheckItems: checkPoints,
    flashcards,
    noteSummary: noteText.join("\n")
  };
}

// 添付写真をS3から取得し、OpenAI Visionに渡せる base64 data URL の配列にする。
// 取得に失敗した写真はスキップし、全体は止めない。
async function fetchAttachmentImages(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];

  if (list.length === 0 || !ATTACHMENTS_BUCKET) {
    return [];
  }

  const images = [];

  for (const att of list.slice(0, MAX_VISION_IMAGES)) {
    if (!att?.s3Key) continue;

    try {
      const res = await s3Client.send(
        new GetObjectCommand({
          Bucket: ATTACHMENTS_BUCKET,
          Key: att.s3Key
        })
      );

      const bytes = await res.Body.transformToByteArray();
      const contentType = att.contentType || res.ContentType || "image/jpeg";
      const base64 = Buffer.from(bytes).toString("base64");

      images.push(`data:${contentType};base64,${base64}`);
    } catch (error) {
      console.error("fetchAttachmentImages failed:", att.s3Key, error);
    }
  }

  console.log("vision images attached:", images.length);
  return images;
}

async function callOpenAIOnce(apiKey, prompt, input, images = []) {
  console.log("===== OPENAI REQUEST =====");
  console.log("model:", OPENAI_MODEL);
  console.log("transcript chars:", input.transcript.length);
  console.log("prompt chars:", prompt.length);
  console.log("prompt bytes:", Buffer.byteLength(prompt, "utf8"));
  console.log("max_output_tokens:", MAX_OUTPUT_TOKENS);

  const imageList = Array.isArray(images) ? images : [];
  console.log("vision images:", imageList.length);

  // 画像があるときは user メッセージを input_text + input_image の配列にする。
  // 画像がないときは従来通りの文字列。
  const userContent = imageList.length
    ? [
        { type: "input_text", text: prompt },
        ...imageList.map((url) => ({ type: "input_image", image_url: url }))
      ]
    : prompt;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content: "あなたは資格試験の学習ログをJSONに整理する専門AIです。写真が添付された場合は、写真内の文字も読み取って(OCR)学習内容として活用してください。必ずJSONだけを返してください。"
          },
          {
            role: "user",
            content: userContent
          }
        ],
        text: {
          format: {
            type: "json_object"
          }
        },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI API error:", response.status, errorText);
      const e = new Error(`OpenAI API error: ${response.status} ${errorText}`);
      e.errorCode = "AI_API_ERROR";
      e.statusCode = response.status;
      throw e;
    }

    const data = await response.json();

    console.log("===== OPENAI RESPONSE =====");
    console.log("usage:", JSON.stringify(data.usage || {}));

    const outputText = extractResponseText(data);
    console.log("output_text chars:", outputText.length);

    const jsonText = extractJsonText(outputText);
    console.log("jsonText chars:", jsonText.length);

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error("JSON PARSE ERROR", jsonText.slice(0, 3000));
      e.errorCode = "AI_INVALID_JSON";
      throw e;
    }

    return normalizeStudyLog(parsed);
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

async function callOpenAIForStudyLog(input) {
  const apiKey = await getOpenAIApiKey();
  const prompt = buildPrompt(input);
  const images = await fetchAttachmentImages(input.attachments);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_OPENAI_ATTEMPTS; attempt++) {
    try {
      console.log(`OpenAI attempt ${attempt}/${MAX_OPENAI_ATTEMPTS}`);
      const result = await callOpenAIOnce(apiKey, prompt, input, images);

      if (!result?.status) {
        const e = new Error("AI result does not have status");
        e.errorCode = "AI_INVALID_JSON";
        throw e;
      }

      return result;
    } catch (error) {
      lastError = error;
      console.error(`OpenAI attempt ${attempt} failed:`, error);

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

async function putItem(item) {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    })
  );
}

async function getJobItem(jobId) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${USER_ID}`,
        SK: jobId
      }
    })
  );

  return result.Item || null;
}

async function mergeJobFields(jobId, fields) {
  const current = await getJobItem(jobId);

  if (!current) {
    throw new Error(`job not found: ${jobId}`);
  }

  const updated = {
    ...current,
    ...fields,
    updatedAt: new Date().toISOString()
  };

  await putItem(updated);

  return updated;
}

async function invokeGenerateWorker(jobId) {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (!functionName) {
    throw new Error("AWS_LAMBDA_FUNCTION_NAME is empty");
  }

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({
        action: "processGenerateLogJob",
        jobId
      }))
    })
  );
}

async function generateLog(body) {
  const validation = validateGenerateInput(body);
  if (!validation.ok) {
    return jsonResponse(validation.statusCode, {
      status: "error",
      errorCode: validation.errorCode,
      message: validation.message
    });
  }

  const trimmed = trimTranscriptForStorage(body.transcript);

  const input = {
    exam: String(body.exam || "").trim(),
    subject: String(body.subject || "").trim(),
    unit: body.unit || "未設定",
    mode: body.mode || "practice",
    durationMinutes: Number(body.durationMinutes || 25),
    transcript: trimmed.transcript,
    transcriptChars: trimmed.transcriptChars,
    originalTranscriptChars: trimmed.originalTranscriptChars,
    transcriptTruncated: trimmed.transcriptTruncated,
    memo: body.memo || "",
    attachments: sanitizeAttachments(body.attachments)
  };

  const now = new Date().toISOString();
  const jobId = createJobId();

  const jobItem = {
    PK: `USER#${USER_ID}`,
    SK: jobId,
    type: "GENERATE_LOG_JOB",
    jobId,
    jobStatus: "queued",
    input,
    createdAt: now,
    updatedAt: now
  };

  await putItem(jobItem);

  try {
    await mergeJobFields(jobId, {
      jobStatus: "processing",
      startedAt: new Date().toISOString()
    });

    await invokeGenerateWorker(jobId);
  } catch (error) {
    console.error("invokeGenerateWorker failed:", error);

    await mergeJobFields(jobId, {
      jobStatus: "error",
      errorCode: "WORKER_INVOKE_FAILED",
      message: "AI処理の開始に失敗しました。Lambdaの実行ロールに lambda:InvokeFunction 権限があるか確認してください。",
      errorDetail: error.message
    });

    return jsonResponse(500, {
      status: "error",
      jobStatus: "error",
      jobId,
      errorCode: "WORKER_INVOKE_FAILED",
      message: "AI処理の開始に失敗しました。Lambdaの実行ロールに lambda:InvokeFunction 権限があるか確認してください。"
    });
  }

  return jsonResponse(202, {
    status: "processing",
    jobStatus: "processing",
    jobId,
    message: "AIログ作成を開始しました。しばらく待ってから結果を取得してください。",
    pollAction: "getGenerateLogJob",
    input: publicInput(input)
  });
}

async function processGenerateLogJob(body) {
  const jobId = body.jobId;

  if (!jobId) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "NO_JOB_ID",
      message: "jobId is required"
    });
  }

  const job = await getJobItem(jobId);

  if (!job) {
    return jsonResponse(404, {
      status: "error",
      errorCode: "JOB_NOT_FOUND",
      message: "job not found"
    });
  }

  if (job.jobStatus === "done") {
    return jsonResponse(200, {
      status: "ok",
      message: "already done",
      jobId
    });
  }

  console.log("processGenerateLogJob started:", jobId);

  try {
    await mergeJobFields(jobId, {
      jobStatus: "processing",
      workerStartedAt: new Date().toISOString()
    });

    const studyLog = await callOpenAIForStudyLog(job.input);

    if (studyLog.status === "error") {
      await mergeJobFields(jobId, {
        jobStatus: "error",
        errorCode: studyLog.errorCode || "NOT_STUDY_CONTENT",
        message: studyLog.message || "学習内容として判定できませんでした。",
        studyLog,
        completedAt: new Date().toISOString()
      });

      return jsonResponse(200, {
        status: "error",
        jobStatus: "error",
        jobId,
        errorCode: studyLog.errorCode || "NOT_STUDY_CONTENT",
        message: studyLog.message || "学習内容として判定できませんでした。"
      });
    }

    await mergeJobFields(jobId, {
      jobStatus: "done",
      studyLog,
      completedAt: new Date().toISOString()
    });

    console.log("processGenerateLogJob done:", jobId);

    return jsonResponse(200, {
      status: "ok",
      jobStatus: "done",
      jobId
    });
  } catch (error) {
    console.error("processGenerateLogJob failed:", error);

    await mergeJobFields(jobId, {
      jobStatus: "error",
      errorCode: error.errorCode || "AI_RETRY_FAILED",
      message: "AI処理に失敗しました。もう一度お試しください。",
      errorDetail: error.message,
      completedAt: new Date().toISOString()
    });

    return jsonResponse(200, {
      status: "error",
      jobStatus: "error",
      jobId,
      errorCode: error.errorCode || "AI_RETRY_FAILED",
      message: "AI処理に失敗しました。もう一度お試しください。"
    });
  }
}

async function getGenerateLogJob(body) {
  const jobId = body.jobId;

  if (!jobId) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "NO_JOB_ID",
      message: "jobId is required"
    });
  }

  const job = await getJobItem(jobId);

  if (!job) {
    return jsonResponse(404, {
      status: "error",
      errorCode: "JOB_NOT_FOUND",
      message: "job not found"
    });
  }

  if (job.jobStatus === "done") {
    return jsonResponse(200, {
      status: "ok",
      jobStatus: "done",
      jobId,
      message: "AIログ作成が完了しました。",
      input: publicInput(job.input || {}),
      studyLog: job.studyLog,
      createdAt: job.createdAt,
      completedAt: job.completedAt
    });
  }

  if (job.jobStatus === "error") {
    return jsonResponse(200, {
      status: "error",
      jobStatus: "error",
      jobId,
      errorCode: job.errorCode || "AI_JOB_ERROR",
      message: job.message || "AIログ作成に失敗しました。",
      input: publicInput(job.input || {}),
      createdAt: job.createdAt,
      completedAt: job.completedAt
    });
  }

  return jsonResponse(200, {
    status: "processing",
    jobStatus: job.jobStatus || "processing",
    jobId,
    message: "AIログ作成中です。",
    input: publicInput(job.input || {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
}

// 「今日何セット目か」をJST基準で数える。
// SKはUTCのISO日時なので、JSTの1日(00:00〜24:00 JST)に対応するUTC範囲をBETWEENで引く。
async function getTodaySetNumber(createdAt) {
  const jstDate = toJstDate(createdAt);
  const dayStartMs = Date.parse(`${jstDate}T00:00:00+09:00`);

  if (!Number.isFinite(dayStartMs)) {
    return 1;
  }

  const startIso = new Date(dayStartMs).toISOString();
  const endIso = new Date(dayStartMs + 24 * 60 * 60 * 1000).toISOString();

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":pk": `USER#${USER_ID}`,
        ":start": `SESSION#${startIso}`,
        ":end": `SESSION#${endIso}`
      },
      Select: "COUNT"
    })
  );

  return Number(result.Count || 0) + 1;
}

// 添付メタデータの正規化。s3Keyを持つものだけ、最大MAX_ATTACHMENTS件まで保存する。
function sanitizeAttachments(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((att) => att && typeof att === "object" && att.s3Key)
    .slice(0, MAX_ATTACHMENTS)
    .map((att) => ({
      s3Key: String(att.s3Key).slice(0, 300),
      contentType: String(att.contentType || "image/jpeg").slice(0, 100),
      caption: String(att.caption || "").slice(0, 200)
    }));
}

async function saveSession(body) {
  const now = new Date().toISOString();
  const createdAt = body.createdAt || now;
  const sessionSk = body.sessionSk || `SESSION#${createdAt}`;

  const exam = String(body.exam || "").trim() || "未設定";
  const subject = body.subject || "未設定";
  const unit = body.unit || "未設定";
  const mode = body.mode || "practice";
  const durationMinutes = Number(body.durationMinutes || 25);
  const attachments = sanitizeAttachments(body.attachments);

  const subjectNormalized = sanitizeKey(subject) || "未設定";
  const unitNormalized = sanitizeKey(unit) || "未設定";

  const studyLog = normalizeStudyLog(body.studyLog || body);

  if (studyLog.status === "error") {
    return jsonResponse(400, studyLog);
  }

  const setNumber = body.setNumber ? Number(body.setNumber) : await getTodaySetNumber(createdAt);

  const sessionItem = {
    PK: `USER#${USER_ID}`,
    SK: sessionSk,
    type: "SESSION",
    date: toJstDate(createdAt),
    setNumber,
    exam,
    subject,
    subjectNormalized,
    unit,
    unitNormalized,
    mode,
    durationMinutes,

    status: studyLog.status,
    summary: studyLog.summary,
    checkPoints: studyLog.checkPoints,
    explanations: studyLog.explanations,
    visibleCards: studyLog.visibleCards,
    savedCards: studyLog.savedCards,
    noteText: studyLog.noteText,

    mainStuckPoint: studyLog.mainStuckPoint,
    understoodPoints: studyLog.understoodPoints,
    weakPoints: studyLog.weakPoints,
    weakPointExplanations: studyLog.weakPointExplanations,
    explainCheckItems: studyLog.explainCheckItems,
    flashcards: studyLog.flashcards,
    noteSummary: studyLog.noteSummary,

    attachments,
    rawInputSaved: false,
    createdAt
  };

  await putItem(sessionItem);

  const weakItems = [];

  for (const wp of studyLog.weakPoints) {
    const weakKey = sanitizeKey(wp.key || wp.label || "weak");
    const explanation = studyLog.weakPointExplanations.find((ex) => ex.key === weakKey)
      || studyLog.weakPointExplanations.find((ex) => sanitizeKey(ex.label) === weakKey);

    const weakItem = {
      PK: `USER#${USER_ID}`,
      SK: `WEAK#${weakKey}#${createdAt}`,
      type: "WEAK_POINT",
      weakKey,
      weakLabel: wp.label,
      exam,
      subject,
      unit,
      unitNormalized,
      mode,
      sessionSk,
      reason: wp.reason,
      explanation: explanation?.explanation || "",
      example: explanation?.example || "",
      severity: wp.severity,
      status: "unresolved",
      createdAt
    };

    weakItems.push(weakItem);
    await putItem(weakItem);
  }

  return jsonResponse(200, {
    status: "ok",
    message: "saveSession success",
    session: sessionItem,
    weakItems
  });
}

// 一覧表示用の軽量フィールド。light: true のとき本文(カード・解説)を省いて返す。
const LIGHT_FIELDS = [
  "SK", "type", "date", "setNumber",
  "exam", "subject", "subjectNormalized", "unit", "unitNormalized",
  "mode", "durationMinutes", "summary", "attachments", "createdAt"
];

async function listSessions(body) {
  const yearMonth = body.yearMonth || "";
  const prefix = yearMonth
    ? `SESSION#${yearMonth}`
    : "SESSION#";

  const limit = Math.min(Math.max(Number(body.limit || 50), 1), 500);
  const light = !!body.light;

  const expressionAttributeNames = {};
  let projectionExpression;

  if (light) {
    projectionExpression = LIGHT_FIELDS
      .map((field, index) => {
        const alias = `#f${index}`;
        expressionAttributeNames[alias] = field;
        return alias;
      })
      .join(", ");
  }

  const items = [];
  let exclusiveStartKey;

  // 旧実装は1回のQueryのみで、Limit超過や1MB超過の続きが取れなかった。
  // LastEvaluatedKeyを追ってlimit件まで集める。
  do {
    const params = {
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `USER#${USER_ID}`,
        ":prefix": prefix
      },
      Limit: limit - items.length,
      ScanIndexForward: false
    };

    if (light) {
      params.ProjectionExpression = projectionExpression;
      params.ExpressionAttributeNames = expressionAttributeNames;
    }

    if (exclusiveStartKey) {
      params.ExclusiveStartKey = exclusiveStartKey;
    }

    const result = await docClient.send(new QueryCommand(params));

    items.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey && items.length < limit);

  return jsonResponse(200, {
    status: "ok",
    message: "listSessions success",
    sessions: items,
    hasMore: !!exclusiveStartKey
  });
}

// 添付に閲覧用の署名付きGET URLを付けて返す。
async function withAttachmentUrls(session) {
  const attachments = Array.isArray(session.attachments) ? session.attachments : [];

  if (attachments.length === 0 || !ATTACHMENTS_BUCKET) {
    return session;
  }

  const enriched = [];

  for (const att of attachments) {
    if (!att?.s3Key) {
      enriched.push(att);
      continue;
    }

    try {
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: ATTACHMENTS_BUCKET,
          Key: att.s3Key
        }),
        { expiresIn: VIEW_URL_EXPIRES_SEC }
      );

      enriched.push({ ...att, url });
    } catch (error) {
      console.error("getSignedUrl (GET) failed:", att.s3Key, error);
      enriched.push({ ...att });
    }
  }

  return { ...session, attachments: enriched };
}

async function getSession(body) {
  if (!body.sessionSk) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "NO_SESSION_SK",
      message: "sessionSk is required"
    });
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${USER_ID}`,
        SK: body.sessionSk
      }
    })
  );

  if (!result.Item) {
    return jsonResponse(404, {
      status: "error",
      errorCode: "SESSION_NOT_FOUND",
      message: "session not found"
    });
  }

  const session = await withAttachmentUrls(result.Item);

  return jsonResponse(200, {
    status: "ok",
    message: "getSession success",
    session
  });
}

// 復習カードの「理解!」状態を保存する。
// body: { sessionSk, source: "savedCards" | "flashcards", cardIndex, understood }
// understood: true でカードを卒業(復習デッキに出さない)、false で復活。
async function markCardUnderstood(body) {
  const sessionSk = String(body.sessionSk || "").trim();
  const cardIndex = Number(body.cardIndex);
  const understood = body.understood !== false;

  if (!sessionSk) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "NO_SESSION_SK",
      message: "sessionSk is required"
    });
  }

  if (!Number.isInteger(cardIndex) || cardIndex < 0) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "INVALID_CARD_INDEX",
      message: "cardIndex is invalid"
    });
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${USER_ID}`,
        SK: sessionSk
      }
    })
  );

  const item = result.Item;

  if (!item) {
    return jsonResponse(404, {
      status: "error",
      errorCode: "SESSION_NOT_FOUND",
      message: "session not found"
    });
  }

  const requestedSource = String(body.source || "").trim();
  const source = requestedSource === "savedCards" || requestedSource === "flashcards"
    ? requestedSource
    : (Array.isArray(item.savedCards) && item.savedCards.length > 0 ? "savedCards" : "flashcards");

  const cards = item[source];

  if (!Array.isArray(cards) || cardIndex >= cards.length) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "CARD_NOT_FOUND",
      message: `card not found: ${source}[${cardIndex}]`
    });
  }

  cards[cardIndex] = {
    ...cards[cardIndex],
    understood,
    understoodAt: understood ? new Date().toISOString() : null
  };

  await putItem({
    ...item,
    [source]: cards,
    updatedAt: new Date().toISOString()
  });

  return jsonResponse(200, {
    status: "ok",
    message: "markCardUnderstood success",
    sessionSk,
    source,
    cardIndex,
    understood
  });
}

const EXT_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

// 写真アップロード用の署名付きPUT URLを発行する。
// フロントはこのURLに Content-Type を一致させて PUT し、返ってきた s3Key を
// saveSession の attachments に入れる。
async function getUploadUrl(body) {
  if (!ATTACHMENTS_BUCKET) {
    return jsonResponse(500, {
      status: "error",
      errorCode: "NO_ATTACHMENTS_BUCKET",
      message: "Lambda環境変数 ATTACHMENTS_BUCKET が未設定です。S3バケット名を設定してください。"
    });
  }

  const contentType = String(body.contentType || "").trim().toLowerCase();
  const ext = EXT_BY_CONTENT_TYPE[contentType];

  if (!ext) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "INVALID_CONTENT_TYPE",
      message: "添付できる画像は jpeg / png / webp / gif のみです。"
    });
  }

  const now = new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 10);
  const s3Key = `attachments/${toJstDate(now)}/${now.replace(/[:.]/g, "-")}-${rand}.${ext}`;

  const uploadUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Key: s3Key,
      ContentType: contentType
    }),
    { expiresIn: UPLOAD_URL_EXPIRES_SEC }
  );

  return jsonResponse(200, {
    status: "ok",
    message: "getUploadUrl success",
    uploadUrl,
    s3Key,
    contentType,
    expiresInSeconds: UPLOAD_URL_EXPIRES_SEC
  });
}

async function listWeakPoints(body) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `USER#${USER_ID}`,
        ":prefix": "WEAK#"
      },
      Limit: Number(body.limit || 100),
      ScanIndexForward: false
    })
  );

  const weakItems = result.Items || [];
  const grouped = {};

  for (const item of weakItems) {
    const key = item.weakKey || "unknown";

    if (!grouped[key]) {
      grouped[key] = {
        weakKey: key,
        weakLabel: item.weakLabel || key,
        count: 0,
        latestAt: item.createdAt,
        latestReason: item.reason,
        latestExplanation: item.explanation || "",
        latestExample: item.example || "",
        latestSubject: item.subject,
        items: []
      };
    }

    grouped[key].count += 1;
    grouped[key].items.push(item);

    if (item.createdAt > grouped[key].latestAt) {
      grouped[key].latestAt = item.createdAt;
      grouped[key].latestReason = item.reason;
      grouped[key].latestExplanation = item.explanation || "";
      grouped[key].latestExample = item.example || "";
      grouped[key].latestSubject = item.subject;
    }
  }

  return jsonResponse(200, {
    status: "ok",
    message: "listWeakPoints success",
    weakPoints: Object.values(grouped).sort((a, b) => b.count - a.count),
    rawItems: weakItems
  });
}

export const handler = async (event) => {
  try {
    if (event?.requestContext?.http?.method === "OPTIONS") {
      return jsonResponse(200, {
        status: "ok",
        message: "ok"
      });
    }

    const body = parseBody(event);
    const action = body.action || "health";

    console.log("action:", action);

    if (action === "health") {
      const apiKey = await getOpenAIApiKey();

      return jsonResponse(200, {
        status: "ok",
        message: "EurekaStudyApi is healthy",
        hasOpenAiKey: !!apiKey,
        model: OPENAI_MODEL,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        asyncMode: true,
        attachmentsBucket: ATTACHMENTS_BUCKET || null
      });
    }

    if (action === "generateLog") {
      return await generateLog(body);
    }

    if (action === "processGenerateLogJob") {
      return await processGenerateLogJob(body);
    }

    if (action === "getGenerateLogJob" || action === "getGenerateJob" || action === "getJob") {
      return await getGenerateLogJob(body);
    }

    if (action === "saveSession") {
      return await saveSession(body);
    }

    if (action === "listSessions") {
      return await listSessions(body);
    }

    if (action === "getSession") {
      return await getSession(body);
    }

    if (action === "getUploadUrl") {
      return await getUploadUrl(body);
    }

    if (action === "markCardUnderstood" || action === "setCardUnderstood") {
      return await markCardUnderstood(body);
    }

    if (action === "listWeakPoints") {
      return await listWeakPoints(body);
    }

    return jsonResponse(400, {
      status: "error",
      errorCode: "UNKNOWN_ACTION",
      message: `Unknown action: ${action}`
    });
  } catch (error) {
    console.error("handler error:", error);

    return jsonResponse(500, {
      status: "error",
      errorCode: error.errorCode || "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
      error: error.message
    });
  }
};
