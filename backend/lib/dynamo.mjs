import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = "ap-northeast-1";
export const TABLE_NAME = "ReRikaiTable";
export const USER_ID = process.env.USER_ID || "naohiro";

const ddbClient = new DynamoDBClient({ region: REGION });
export const docClient = DynamoDBDocumentClient.from(ddbClient);

export async function putItem(item) {
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

// 同一キーのアイテムが存在しない場合のみ書き込む（冪等性用）。
// 既に存在すると ConditionalCheckFailedException を投げる（呼び出し側で捕捉）。
export async function putNewItem(item) {
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(PK)"
  }));
}

export async function getItem(sk) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${USER_ID}`, SK: sk }
    })
  );
  return result.Item || null;
}

export async function queryByPrefix(prefix, options = {}) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `USER#${USER_ID}`,
        ":prefix": prefix
      },
      ScanIndexForward: options.scanIndexForward ?? false,
      Limit: options.limit
    })
  );
  return result.Items || [];
}
