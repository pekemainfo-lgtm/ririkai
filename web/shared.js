// APIエンドポイント（公開HTTPS。秘密情報ではない）。localStorageで上書き可能。
const DEFAULT_API_URL = "https://x1y8yib6vd.execute-api.ap-northeast-1.amazonaws.com/api";
const API_URL_STORAGE_KEY = "ririkaiApiUrl";
const FETCH_TIMEOUT_MS = 45000;

function getApiUrl() {
  const stored = localStorage.getItem(API_URL_STORAGE_KEY);
  return (stored || DEFAULT_API_URL).trim();
}

function setApiUrl(url) {
  localStorage.setItem(API_URL_STORAGE_KEY, url.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapLambdaResponse(data) {
  if (data && typeof data.body === "string") {
    try {
      return JSON.parse(data.body);
    } catch {
      return data;
    }
  }
  return data;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("API通信がタイムアウトしました。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callApi(payload) {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    throw new Error("API URLが設定されていません。");
  }

  const response = await fetchWithTimeout(apiUrl, {
    method: "POST",
    headers: {
      // text/plain にして、ブラウザのCORSプリフライトを避ける
      "Content-Type": "text/plain;charset=UTF-8"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("APIの返答をJSONとして読めませんでした: " + text.slice(0, 300));
  }

  data = unwrapLambdaResponse(data);

  if (!response.ok && response.status !== 202) {
    throw new Error(data.message || data.error || "API error: " + response.status);
  }

  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
