import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const SHARED_FILES_BUCKET = process.env.SHARED_FILES_BUCKET!;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;
const GATEWAY_HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const OPENCLAW_BACKEND_MODE = process.env.OPENCLAW_BACKEND_MODE || "local";
const AGENTCORE_REGION = process.env.AGENTCORE_REGION || "us-east-1";
const AGENTCORE_RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN || "";
const AGENTCORE_RUNTIME_ENDPOINT_ID = process.env.AGENTCORE_RUNTIME_ENDPOINT_ID || "";
const AGENTCORE_ACTOR_ID = process.env.AGENTCORE_ACTOR_ID || "";
const AGENTCORE_CHANNEL = process.env.AGENTCORE_CHANNEL || "test";

export const handler = async (event: any): Promise<APIGatewayProxyResult | any> => {
  console.log("Event:", JSON.stringify(event));

  // 1. WebSocket Handling
  if (event.requestContext && event.requestContext.connectionId) {
    return handleWebSocket(event);
  }

  // 2. HTTP API Handling
  return handleHttp(event);
};

async function handleWebSocket(event: any): Promise<any> {
  const { connectionId, routeKey } = event.requestContext;

  switch (routeKey) {
    case "$connect":
      await docClient.send(new PutCommand({
        TableName: CONNECTIONS_TABLE,
        Item: { connectionId, timestamp: Date.now() },
      }));
      return { statusCode: 200, body: "Connected" };

    case "$disconnect":
      await docClient.send(new DeleteCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId },
      }));
      return { statusCode: 200, body: "Disconnected" };

    default:
      return { statusCode: 200, body: "OK" };
  }
}

async function handleHttp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { path, httpMethod } = event;
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (path === "/api/openclaw/snapshot") {
    try {
      const snapshot = await fetchSnapshot();
      return { statusCode: 200, headers, body: JSON.stringify(snapshot) };
    } catch (err: any) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (path === "/api/openclaw/push-event") {
    if (httpMethod !== "POST") {
      return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }
    try {
      const eventData = JSON.parse(event.body || "{}");
      console.log("Pushing event to all clients:", JSON.stringify(eventData));
      await broadcast(eventData);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err: any) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (path === "/api/files") {
    const relPath = event.queryStringParameters?.path || "";
    try {
      const data = await s3Client.send(new ListObjectsV2Command({
        Bucket: SHARED_FILES_BUCKET,
        Prefix: relPath ? (relPath.endsWith("/") ? relPath : relPath + "/") : "",
        Delimiter: "/",
      }));

      const entries = [
        ...(data.CommonPrefixes || []).map(p => ({ 
          name: p.Prefix?.split("/").filter(Boolean).pop(), 
          type: "dir" 
        })),
        ...(data.Contents || []).map(c => ({ 
          name: c.Key?.split("/").pop(), 
          type: "file" 
        })).filter(f => f.name),
      ];

      return { statusCode: 200, headers, body: JSON.stringify({ path: relPath, entries }) };
    } catch (err: any) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (path === "/api/file") {
    const relPath = event.queryStringParameters?.path || "";
    try {
      const data = await s3Client.send(new GetObjectCommand({
        Bucket: SHARED_FILES_BUCKET,
        Key: relPath,
      }));

      const body = await data.Body?.transformToString("base64");
      const contentType = data.ContentType || "application/octet-stream";

      return {
        statusCode: 200,
        headers: {
          ...headers,
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${relPath.split("/").pop()}"`,
        },
        body: body || "",
        isBase64Encoded: true,
      };
    } catch (err: any) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: "Not Found" }) };
}

async function fetchSnapshot(): Promise<any> {
  // Simplification of fetchGatewaySnapshot for Lambda environment
  // In a real serverless env, the Gateway should be accessible via HTTP/WS
  if (OPENCLAW_BACKEND_MODE === "agentcore") {
    return fetchAgentCoreSnapshot();
  }

  // Local Gateway Mock/Proxy
  // For now, return a basic structure or attempt a fetch if host is reachable
  const wsUrl = `ws://${GATEWAY_HOST}:18789`;
  console.log(`Connecting to gateway at ${wsUrl}`);
  
  // Note: Standard WebSocket client might not be available in Node Lambda without 'ws' package
  // Since we installed 'ws', we can use it.
  const { WebSocket } = await import("ws");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Gateway snapshot timeout"));
    }, 10000);

    ws.on("open", () => {
      // Send connect request
      ws.send(JSON.stringify({
        type: "req",
        id: "connect",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "serverless-dashboard", version: "1.0.0" },
          role: "operator",
        }
      }));
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "connect" && msg.ok) {
        // Request agents list as a proxy for a "snapshot"
        ws.send(JSON.stringify({ type: "req", id: "snapshot", method: "agents.list", params: {} }));
      } else if (msg.id === "snapshot") {
        clearTimeout(timeout);
        ws.close();
        const snapshot = {
          agents: msg.payload,
          fetchedAt: Date.now(),
          source: wsUrl
        };
        // Broadcast the snapshot to all connected clients
        void broadcast({ type: "snapshot", payload: snapshot });
        resolve(snapshot);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}


async function broadcast(message: any) {
  const connections = await docClient.send(new ScanCommand({ TableName: CONNECTIONS_TABLE }));
  const apigwClient = new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_ENDPOINT });

  const payload = JSON.stringify(message);
  const promises = (connections.Items || []).map(async (conn) => {
    try {
      await apigwClient.send(new PostToConnectionCommand({
        ConnectionId: conn.connectionId,
        Data: payload,
      }));
    } catch (err: any) {
      if (err.name === "GoneException") {
        await docClient.send(new DeleteCommand({
          TableName: CONNECTIONS_TABLE,
          Key: { connectionId: conn.connectionId },
        }));
      }
    }
  });

  await Promise.all(promises);
}

async function fetchAgentCoreSnapshot(): Promise<any> {
  const identity = await resolveAgentCoreIdentity();
  const payload = (await invokeAgentCoreAction({
    action: "dashboard_snapshot",
    userId: identity.userId,
    actorId: AGENTCORE_ACTOR_ID,
    channel: AGENTCORE_CHANNEL,
    sessionId: identity.runtimeSessionId,
  })) as any;

  if (payload.status !== "ready" || !payload.snapshot) {
    throw new Error(payload.error ?? `AgentCore snapshot failed with status ${payload.status}`);
  }

  return payload.snapshot;
}

async function invokeAgentCoreAction(actionPayload: any): Promise<any> {
  const client = new BedrockAgentCoreClient({ region: AGENTCORE_REGION });
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: AGENTCORE_RUNTIME_ARN,
    qualifier: AGENTCORE_RUNTIME_ENDPOINT_ID,
    runtimeSessionId: (await resolveAgentCoreIdentity()).runtimeSessionId,
    contentType: "application/json",
    accept: "application/json",
    payload: Buffer.from(JSON.stringify(actionPayload), "utf8"),
  });

  const response = await client.send(command);
  const body = response.response;
  if (!body) throw new Error("AgentCore returned no body");

  const text = typeof body.transformToString === "function"
    ? await body.transformToString()
    : Buffer.from(await body.transformToByteArray()).toString("utf8");

  return JSON.parse(text);
}

async function resolveAgentCoreIdentity(): Promise<{ userId: string; runtimeSessionId: string }> {
  // Use explicit environment variables if available
  if (process.env.AGENTCORE_USER_ID && process.env.AGENTCORE_RUNTIME_SESSION_ID) {
    return {
      userId: process.env.AGENTCORE_USER_ID,
      runtimeSessionId: process.env.AGENTCORE_RUNTIME_SESSION_ID,
    };
  }

  // Fallback to DynamoDB resolution logic (simplified for Lambda)
  const identityTableName = process.env.AGENTCORE_IDENTITY_TABLE_NAME || "openclaw-identity";
  const userId = process.env.AGENTCORE_USER_ID || `dashboard-user-${createHash("sha1").update(AGENTCORE_ACTOR_ID).digest("hex").slice(0, 12)}`;
  
  // Attempt to resolve from DDB if not explicit
  try {
    const sessionRecord = await docClient.send(new GetCommand({
      TableName: identityTableName,
      Key: {
        PK: `USER#${userId}`,
        SK: "SESSION",
      },
    }));

    const runtimeSessionId = sessionRecord.Item?.sessionId || `dashboard_session_${createHash("sha1").update(AGENTCORE_ACTOR_ID).digest("hex").slice(0, 24)}`;
    return { userId, runtimeSessionId };
  } catch (err) {
    console.warn("Failed to resolve identity from DDB, using defaults:", err);
    return {
      userId,
      runtimeSessionId: `dashboard_session_${createHash("sha1").update(AGENTCORE_ACTOR_ID).digest("hex").slice(0, 24)}`,
    };
  }
}
