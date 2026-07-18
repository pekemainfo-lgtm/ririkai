import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export { sessionMarkdownKey } from "./keys.mjs";

const REGION = "ap-northeast-1";
export const DATA_BUCKET = process.env.DATA_BUCKET || "";
const MARKDOWN_VIEW_URL_EXPIRES_SEC = 900;

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
