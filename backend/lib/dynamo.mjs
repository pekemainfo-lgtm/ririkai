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
