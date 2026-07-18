import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { putItem, getItem, queryByPrefix, USER_ID } from "./lib/dynamo.mjs";
import { toJstDate } from "./lib/dates.mjs";
import { validateCreateSessionInput } from "./lib/validate.mjs";
import { buildSessionMarkdown } from "./lib/markdown.mjs";
import { callOpenAIForAnalysis, callOpenAIForCards } from "./lib/openai.mjs";
import {
  buildCardItem,
  validateCardInput,
  sanitizeCardType,
  normalizeQuestion,
  findDuplicateCards,
  integrateAnswer,
  mergeCardData
} from "./lib/cards.mjs";
import { sessionMarkdownKey, putSessionMarkdown, getSessionMarkdownUrl, DATA_BUCKET } from "./lib/storage.mjs";

const REGION = "ap-northeast-1";
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

const lambdaClient = new LambdaClient({ region: REGION });

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
    } catch {
      const e = new Error("Request body is not valid JSON");
      e.errorCode = "INVALID_REQUEST_JSON";
      throw e;
    }
  }
  return event.body;
}

function createId(prefix) {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${now}${rand}`;
}

function splitLines(text, max = 20) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^[-・\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, max);
}

async function invokeProcessSessionJob(sessionSk, jobSk) {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw new Error("AWS_LAMBDA_FUNCTION_NAME is empty");
  }

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ action: "processSessionJob", sessionSk, jobSk }))
    })
  );
}

async function createSession(body) {
  const validation = validateCreateSessionInput(body);
  if (!validation.ok) {
    return jsonResponse(validation.statusCode, {
      status: "error",
      errorCode: validation.errorCode,
      message: validation.message
    });
  }

  const now = new Date().toISOString();
  const sessionId = createId("session");
  const sessionSk = `SESSION#${now}`;
  const jobSk = `JOB#${now}#${Math.random().toString(36).slice(2, 8)}`;
  const studyDate = body.studyDate || toJstDate(now);

  const qualification = String(body.qualification || "").trim();
  const subject = String(body.subject || "").trim();
  const topic = String(body.topic || "").trim();
  const durationMinutes = body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === ""
    ? 25
    : Number(body.durationMinutes);
  const purpose = String(body.purpose || "").trim();
  const notUnderstoodNote = String(body.notUnderstoodNote || "").trim();
  const transcript = String(body.transcript || "").trim();
  const generateCards = body.generateCards !== false;

  const sessionItem = {
    PK: `USER#${USER_ID}`,
    SK: sessionSk,
    type: "SESSION",
    schemaVersion: 1,
    sessionId,
    userId: USER_ID,
    studyDate,
    qualification,
    subject,
    topic,
    durationMinutes,
    purpose,
    notUnderstoodNote,
    sessionStatus: "processing",
    markdownS3Key: null,
    understoodPoints: [],
    ambiguousPoints: [],
    misconceptions: [],
    confirmQuestions: [],
    reviewItems: [],
    purposeJudgement: null,
    generateCards,
    cardStatus: generateCards ? "pending" : "skipped",
    cardCandidates: [],
    cardIds: [],
    createdAt: now,
    updatedAt: now
  };

  const jobItem = {
    PK: `USER#${USER_ID}`,
    SK: jobSk,
    type: "SESSION_JOB",
    sessionSk,
    sessionId,
    input: {
      qualification,
      subject,
      topic,
      purpose,
      notUnderstoodNote,
      transcript,
      generateCards
    },
    createdAt: now,
    expiresAt: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS
  };

  await putItem(sessionItem);
  await putItem(jobItem);

  try {
    await invokeProcessSessionJob(sessionSk, jobSk);
  } catch (error) {
    await putItem({
      ...sessionItem,
      sessionStatus: "failed",
      errorCode: "WORKER_INVOKE_FAILED",
      message: "AI処理の開始に失敗しました。",
      updatedAt: new Date().toISOString()
    });

    return jsonResponse(500, {
      status: "error",
      errorCode: "WORKER_INVOKE_FAILED",
      message: "AI処理の開始に失敗しました。"
    });
  }

  return jsonResponse(202, {
    status: "processing",
    sessionId,
    sessionSk,
    message: "AI分析を開始しました。しばらく待ってから結果を取得してください。",
    pollAction: "getSession"
  });
}

async function processSessionJob(body) {
  const { sessionSk, jobSk } = body;

  if (!sessionSk || !jobSk) {
    return jsonResponse(400, {
      status: "error",
      errorCode: "MISSING_KEYS",
      message: "sessionSk and jobSk are required"
    });
  }

  const [session, job] = await Promise.all([getItem(sessionSk), getItem(jobSk)]);

  if (!session || !job) {
    return jsonResponse(404, {
      status: "error",
      errorCode: "SESSION_OR_JOB_NOT_FOUND",
      message: "session or job not found"
    });
  }

  if (session.sessionStatus === "completed") {
    return jsonResponse(200, { status: "ok", message: "already completed", sessionSk });
  }

  try {
    const analysis = await callOpenAIForAnalysis(job.input);

    if (analysis.status === "error") {
      await putItem({
        ...session,
        sessionStatus: "failed",
        errorCode: analysis.errorCode || "NOT_STUDY_CONTENT",
        message: analysis.message || "学習内容として判定できませんでした。",
        updatedAt: new Date().toISOString()
      });

      return jsonResponse(200, {
        status: "error",
        errorCode: analysis.errorCode || "NOT_STUDY_CONTENT",
        message: analysis.message || "学習内容として判定できませんでした。",
        sessionSk
      });
    }

    const markdownKey = sessionMarkdownKey(USER_ID, session.studyDate, session.sessionId);

    const markdown = buildSessionMarkdown({
      schemaVersion: session.schemaVersion,
      sessionId: session.sessionId,
      userId: USER_ID,
      studyDate: session.studyDate,
      qualification: session.qualification,
      subject: session.subject,
      topic: session.topic,
      durationMinutes: session.durationMinutes,
      status: "completed",
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      cardIds: [],
      noteImages: [],
      purpose: session.purpose,
      purposeJudgement: analysis.purposeJudgement,
      notUnderstoodItems: splitLines(job.input.notUnderstoodNote),
      rawTranscript: job.input.transcript,
      polishedTranscript: analysis.polishedTranscript,
      understoodPoints: analysis.understoodPoints,
      ambiguousPoints: analysis.ambiguousPoints,
      misconceptions: analysis.misconceptions,
      confirmQuestions: analysis.confirmQuestions,
      reviewItems: analysis.reviewItems
    });

    await putSessionMarkdown(markdownKey, markdown);

    const completedSession = {
      ...session,
      sessionStatus: "completed",
      errorCode: null,
      message: null,
      markdownS3Key: markdownKey,
      understoodPoints: analysis.understoodPoints,
      ambiguousPoints: analysis.ambiguousPoints,
      misconceptions: analysis.misconceptions,
      confirmQuestions: analysis.confirmQuestions,
      reviewItems: analysis.reviewItems,
      purposeJudgement: analysis.purposeJudgement,
      updatedAt: new Date().toISOString()
    };

    await putItem(completedSession);

    // カード生成はセッション保存の後に行い、失敗してもセッションは成功のまま（§26）。
    if (job.input.generateCards !== false) {
      try {
        const cardResult = await callOpenAIForCards(job.input, analysis);
        await putItem({
          ...completedSession,
          cardStatus: "done",
          cardCandidates: cardResult.cards,
          cardError: null,
          updatedAt: new Date().toISOString()
        });
      } catch (cardError) {
        console.error("card generation failed:", cardError);
        await putItem({
          ...completedSession,
          cardStatus: "failed",
          cardCandidates: [],
          cardError: cardError.errorCode || "CARD_GEN_FAILED",
          updatedAt: new Date().toISOString()
        });
      }
    }

    return jsonResponse(200, { status: "ok", sessionSk });
  } catch (error) {
    await putItem({
      ...session,
      sessionStatus: "failed",
      errorCode: error.errorCode || "AI_RETRY_FAILED",
      message: "AI処理に失敗しました。もう一度お試しください。",
      updatedAt: new Date().toISOString()
    });

    return jsonResponse(200, {
      status: "error",
      errorCode: error.errorCode || "AI_RETRY_FAILED",
      message: "AI処理に失敗しました。もう一度お試しください。",
      sessionSk
    });
  }
}

async function getSession(body) {
  const sessionSk = String(body.sessionSk || "").trim();

  if (!sessionSk) {
    return jsonResponse(400, { status: "error", errorCode: "NO_SESSION_SK", message: "sessionSk is required" });
  }

  const session = await getItem(sessionSk);

  if (!session) {
    return jsonResponse(404, { status: "error", errorCode: "SESSION_NOT_FOUND", message: "session not found" });
  }

  if (session.sessionStatus === "failed") {
    return jsonResponse(200, {
      status: "error",
      sessionStatus: "failed",
      errorCode: session.errorCode,
      message: session.message,
      session
    });
  }

  return jsonResponse(200, {
    status: session.sessionStatus === "completed" ? "ok" : "processing",
    sessionStatus: session.sessionStatus,
    session
  });
}

async function listSessions(body) {
  const yearMonth = String(body.yearMonth || "").trim();
  const prefix = yearMonth ? `SESSION#${yearMonth}` : "SESSION#";
  const limit = Math.min(Math.max(Number(body.limit || 200), 1), 500);

  const sessions = await queryByPrefix(prefix, { limit, scanIndexForward: false });

  return jsonResponse(200, {
    status: "ok",
    sessions
  });
}

// カード候補を採用してCARD#アイテムを作成する。
// body: { sessionSk, cards: [{question, canonicalAnswer, supplement[], cardType, conceptKey,
//         qualification, subject, answerSource}] }
async function adoptCards(body) {
  const sessionSk = String(body.sessionSk || "").trim();
  const cards = Array.isArray(body.cards) ? body.cards : [];

  if (!sessionSk) {
    return jsonResponse(400, { status: "error", errorCode: "NO_SESSION_SK", message: "sessionSk is required" });
  }

  const session = await getItem(sessionSk);
  if (!session) {
    return jsonResponse(404, { status: "error", errorCode: "SESSION_NOT_FOUND", message: "session not found" });
  }

  if (cards.length === 0) {
    return jsonResponse(400, { status: "error", errorCode: "NO_CARDS", message: "採用するカードがありません。" });
  }

  const created = [];
  const now = new Date().toISOString();

  for (const card of cards) {
    const validation = validateCardInput(card);
    if (!validation.ok) continue;

    const cardId = createId("card");
    const item = buildCardItem({
      userId: USER_ID,
      cardId,
      qualification: card.qualification || session.qualification,
      subject: card.subject || session.subject,
      cardType: card.cardType,
      conceptKey: card.conceptKey,
      question: card.question,
      canonicalAnswer: card.canonicalAnswer,
      supplement: card.supplement,
      sourceSessionId: session.sessionId,
      answerSource: card.answerSource === "user" ? "user" : "ai",
      now
    });

    await putItem(item);
    created.push(item);
  }

  if (created.length === 0) {
    return jsonResponse(400, { status: "error", errorCode: "NO_VALID_CARDS", message: "有効なカードがありませんでした。" });
  }

  const newCardIds = created.map((c) => c.cardId);
  await putItem({
    ...session,
    cardIds: [...(session.cardIds || []), ...newCardIds],
    updatedAt: now
  });

  return jsonResponse(200, {
    status: "ok",
    message: `${created.length}枚のカードを保存しました。`,
    cards: created
  });
}

async function listCards(body) {
  const limit = Math.min(Math.max(Number(body.limit || 300), 1), 500);
  const items = await queryByPrefix("CARD#", { limit, scanIndexForward: false });
  const cards = items.filter((c) => c.status !== "merged");

  return jsonResponse(200, { status: "ok", cards });
}

// 候補カードに対して既存カードの重複を返す（採用前に§10.5の選択UIを出すため）。
// body: { cards: [{question, canonicalAnswer, cardType, conceptKey}] }
async function checkDuplicates(body) {
  const candidates = Array.isArray(body.cards) ? body.cards : [];
  const existing = await queryByPrefix("CARD#", { limit: 500, scanIndexForward: false });

  const results = candidates.map((candidate, index) => {
    const dups = findDuplicateCards(candidate, existing).map((c) => ({
      cardId: c.cardId,
      question: c.question,
      canonicalAnswer: c.canonicalAnswer,
      cardType: c.cardType,
      conceptKey: c.conceptKey,
      status: c.status,
      answerSource: c.answerSource
    }));
    return { index, duplicates: dups };
  });

  return jsonResponse(200, { status: "ok", results });
}

// 既存カードへ新しい回答を統合する（§11）。矛盾は needs_review になる。
// body: { cardId, canonicalAnswer, supplement[], sourceSessionId }
async function mergeAnswerIntoCard(body) {
  const cardId = String(body.cardId || "").trim();
  if (!cardId) {
    return jsonResponse(400, { status: "error", errorCode: "NO_CARD_ID", message: "cardId is required" });
  }

  const card = await getItem(`CARD#${cardId}`);
  if (!card) {
    return jsonResponse(404, { status: "error", errorCode: "CARD_NOT_FOUND", message: "card not found" });
  }

  const answer = String(body.canonicalAnswer || "").trim();
  if (!answer) {
    return jsonResponse(400, { status: "error", errorCode: "NO_ANSWER", message: "答えが未入力です。" });
  }

  const sourceSessionId = String(body.sourceSessionId || "").trim();
  const { result, card: updated } = integrateAnswer(card, answer, body.supplement, sourceSessionId);

  await putItem(updated);

  // セッションとの相互参照（このカードを当該セッションに紐づける）。
  // SESSIONアイテムのSKは createdAt ベースなので、フロントから sessionSk を渡せた場合のみ追記する。
  if (body.sessionSk) {
    const session = await getItem(String(body.sessionSk).trim());
    if (session && !(session.cardIds || []).includes(cardId)) {
      await putItem({
        ...session,
        cardIds: [...(session.cardIds || []), cardId],
        updatedAt: new Date().toISOString()
      });
    }
  }

  return jsonResponse(200, { status: "ok", result, card: updated });
}

// needs_review を解決する（§11.4）。利用者が最終的な canonicalAnswer を確定する。
// body: { cardId, canonicalAnswer, supplement[] }
async function resolveConflict(body) {
  const cardId = String(body.cardId || "").trim();
  if (!cardId) {
    return jsonResponse(400, { status: "error", errorCode: "NO_CARD_ID", message: "cardId is required" });
  }

  const card = await getItem(`CARD#${cardId}`);
  if (!card) {
    return jsonResponse(404, { status: "error", errorCode: "CARD_NOT_FOUND", message: "card not found" });
  }

  const canonicalAnswer = String(body.canonicalAnswer || "").trim();
  if (!canonicalAnswer) {
    return jsonResponse(400, { status: "error", errorCode: "NO_ANSWER", message: "答えが未入力です。" });
  }

  const supplement = Array.isArray(body.supplement)
    ? body.supplement.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
    : card.supplement;

  const updated = {
    ...card,
    canonicalAnswer,
    normalizedQuestion: card.normalizedQuestion || normalizeQuestion(card.question),
    supplement,
    status: "active",
    answerSource: "user",
    pendingAnswer: null,
    updatedAt: new Date().toISOString()
  };

  await putItem(updated);

  return jsonResponse(200, { status: "ok", card: updated });
}

// 利用者による手動統合（§15）。source を target へ吸収し、source は merged にする。
// body: { targetCardId, sourceCardId }
async function mergeCardsManual(body) {
  const targetCardId = String(body.targetCardId || "").trim();
  const sourceCardId = String(body.sourceCardId || "").trim();

  if (!targetCardId || !sourceCardId) {
    return jsonResponse(400, { status: "error", errorCode: "MISSING_CARD_ID", message: "targetCardId and sourceCardId are required" });
  }
  if (targetCardId === sourceCardId) {
    return jsonResponse(400, { status: "error", errorCode: "SAME_CARD", message: "統合元と統合先が同じです。" });
  }

  const [target, source] = await Promise.all([
    getItem(`CARD#${targetCardId}`),
    getItem(`CARD#${sourceCardId}`)
  ]);

  if (!target || !source) {
    return jsonResponse(404, { status: "error", errorCode: "CARD_NOT_FOUND", message: "card not found" });
  }

  const { target: mergedTarget, source: mergedSource } = mergeCardData(target, source);

  await putItem(mergedTarget);
  await putItem(mergedSource);

  return jsonResponse(200, { status: "ok", card: mergedTarget });
}

async function getCard(body) {
  const cardId = String(body.cardId || "").trim();
  if (!cardId) {
    return jsonResponse(400, { status: "error", errorCode: "NO_CARD_ID", message: "cardId is required" });
  }

  const card = await getItem(`CARD#${cardId}`);
  if (!card) {
    return jsonResponse(404, { status: "error", errorCode: "CARD_NOT_FOUND", message: "card not found" });
  }

  return jsonResponse(200, { status: "ok", card });
}

// カードを手動編集する。編集済みは answerSource=user とし、AIが自動上書きしないようにする（§14）。
async function updateCard(body) {
  const cardId = String(body.cardId || "").trim();
  if (!cardId) {
    return jsonResponse(400, { status: "error", errorCode: "NO_CARD_ID", message: "cardId is required" });
  }

  const card = await getItem(`CARD#${cardId}`);
  if (!card) {
    return jsonResponse(404, { status: "error", errorCode: "CARD_NOT_FOUND", message: "card not found" });
  }

  const question = body.question !== undefined ? String(body.question).trim() : card.question;
  const canonicalAnswer = body.canonicalAnswer !== undefined ? String(body.canonicalAnswer).trim() : card.canonicalAnswer;

  const validation = validateCardInput({ question, canonicalAnswer });
  if (!validation.ok) {
    return jsonResponse(400, { status: "error", errorCode: validation.errorCode, message: validation.message });
  }

  const updated = {
    ...card,
    question,
    normalizedQuestion: normalizeQuestion(question),
    canonicalAnswer,
    supplement: Array.isArray(body.supplement)
      ? body.supplement.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
      : card.supplement,
    qualification: body.qualification !== undefined ? String(body.qualification).trim() : card.qualification,
    subject: body.subject !== undefined ? String(body.subject).trim() : card.subject,
    cardType: body.cardType !== undefined ? sanitizeCardType(body.cardType) : card.cardType,
    status: body.status === "inactive" || body.status === "active" ? body.status : card.status,
    answerSource: "user",
    updatedAt: new Date().toISOString()
  };

  await putItem(updated);

  return jsonResponse(200, { status: "ok", card: updated });
}

async function getSessionMarkdown(body) {
  const sessionSk = String(body.sessionSk || "").trim();

  if (!sessionSk) {
    return jsonResponse(400, { status: "error", errorCode: "NO_SESSION_SK", message: "sessionSk is required" });
  }

  const session = await getItem(sessionSk);

  if (!session || !session.markdownS3Key) {
    return jsonResponse(404, { status: "error", errorCode: "MARKDOWN_NOT_FOUND", message: "markdown not found" });
  }

  const url = await getSessionMarkdownUrl(session.markdownS3Key);

  return jsonResponse(200, { status: "ok", url });
}

export const handler = async (event) => {
  try {
    if (event?.requestContext?.http?.method === "OPTIONS") {
      return jsonResponse(200, { status: "ok" });
    }

    const body = parseBody(event);
    const action = body.action || "health";

    if (action === "health") {
      return jsonResponse(200, {
        status: "ok",
        message: "ReRikaiApi is healthy",
        dataBucketConfigured: !!DATA_BUCKET
      });
    }

    if (action === "createSession") {
      return await createSession(body);
    }

    if (action === "processSessionJob") {
      return await processSessionJob(body);
    }

    if (action === "getSession") {
      return await getSession(body);
    }

    if (action === "listSessions") {
      return await listSessions(body);
    }

    if (action === "adoptCards") {
      return await adoptCards(body);
    }

    if (action === "listCards") {
      return await listCards(body);
    }

    if (action === "getCard") {
      return await getCard(body);
    }

    if (action === "updateCard") {
      return await updateCard(body);
    }

    if (action === "checkDuplicates") {
      return await checkDuplicates(body);
    }

    if (action === "mergeAnswerIntoCard") {
      return await mergeAnswerIntoCard(body);
    }

    if (action === "resolveConflict") {
      return await resolveConflict(body);
    }

    if (action === "mergeCardsManual") {
      return await mergeCardsManual(body);
    }

    if (action === "getSessionMarkdown") {
      return await getSessionMarkdown(body);
    }

    return jsonResponse(400, {
      status: "error",
      errorCode: "UNKNOWN_ACTION",
      message: `Unknown action: ${action}`
    });
  } catch (error) {
    return jsonResponse(500, {
      status: "error",
      errorCode: error.errorCode || "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
      error: error.message
    });
  }
};
