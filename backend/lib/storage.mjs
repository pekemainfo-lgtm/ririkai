import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { noteImageExt, noteImageKey } from "./keys.mjs";
import { toJstDate } from "./dates.mjs";

export { sessionMarkdownKey } from "./keys.mjs";

const REGION = "ap-northeast-1";
export const DATA_BUCKET = process.env.DATA_BUCKET || "";
const MARKDOWN_VIEW_URL_EXPIRES_SEC = 900;
const NOTE_UPLOAD_URL_EXPIRES_SEC = 300;
const NOTE_VIEW_URL_EXPIRES_SEC = 900;

const s3Client = new S3Client({ region: REGION });

export async function putSessionMarkdown(key, markdown) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: DATA_BUCKET,
      Key: key,
      Body: markdown,
      ContentType: "text/markdown; charset=utf-8"
    })
  );
}

export async function getSessionMarkdownUrl(key) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }),
    { expiresIn: MARKDOWN_VIEW_URL_EXPIRES_SEC }
  );
}

// ノート写真アップロード用の署名付きPUT URLを発行する（§8.2）。
// 未対応の contentType なら null を返す（呼び出し側で400）。
export async function createNoteUploadUrl(userId, contentType) {
  const ext = noteImageExt(contentType);
  if (!ext) return null;

  const now = new Date().toISOString();
  const imageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const s3Key = noteImageKey(userId, toJstDate(now), imageId, ext);
  const normalizedType = String(contentType).trim().toLowerCase();

  const uploadUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: DATA_BUCKET, Key: s3Key, ContentType: normalizedType }),
    { expiresIn: NOTE_UPLOAD_URL_EXPIRES_SEC }
  );

  return { uploadUrl, s3Key, contentType: normalizedType, expiresInSeconds: NOTE_UPLOAD_URL_EXPIRES_SEC };
}

// ノート写真の閲覧用の署名付きGET URLを発行する。
export async function getNoteImageViewUrl(s3Key) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: DATA_BUCKET, Key: s3Key }),
    { expiresIn: NOTE_VIEW_URL_EXPIRES_SEC }
  );
}
