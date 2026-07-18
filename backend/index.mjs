import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { putItem, getItem, queryByPrefix, USER_ID } from "./lib/dynamo.mjs";
import { toJstDate } from "./lib/dates.mjs";
import { validateCreateSessionInput } from "./lib/validate.mjs";
import { buildSessionMarkdown } from "./lib/markdown.mjs";
import { callOpenAIForAnalysis } from "./lib/openai.mjs";
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
      transcript
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

    await putItem({
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
    });

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
