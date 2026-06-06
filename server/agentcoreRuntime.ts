import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimeEndpointsCommand,
  ListAgentRuntimesCommand,
  type ListAgentRuntimeEndpointsCommandOutput,
  type ListAgentRuntimesCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore-control";

export const DEFAULT_AGENTCORE_RUNTIME_ENDPOINT_NAME = "DEFAULT";

export type AgentRuntimeSummary = NonNullable<
  ListAgentRuntimesCommandOutput["agentRuntimes"]
>[number];
export type AgentRuntimeEndpointSummary = NonNullable<
  ListAgentRuntimeEndpointsCommandOutput["runtimeEndpoints"]
>[number];

export type ResolvedAgentCoreRuntimeTarget = {
  runtimeArn: string;
  qualifier: string;
  runtimeId: string;
  runtimeName: string;
  endpointName: string;
};

type InferAgentCoreIdentityTableNameParams = {
  qualifier: string;
  explicitTableName?: string;
  explicitSuffix?: string;
};

type ResolveAgentCoreRuntimeTargetParams = {
  region: string;
  runtimeName?: string;
  endpointName?: string;
  runtimeArn?: string;
  qualifier?: string;
};

export function inferAgentCoreIdentityTableName(
  params: InferAgentCoreIdentityTableNameParams,
): string {
  if (params.explicitTableName) {
    return params.explicitTableName;
  }

  if (params.explicitSuffix) {
    return params.explicitSuffix === "prod"
      ? "openclaw-identity-prod"
      : `openclaw-identity-${params.explicitSuffix}`;
  }

  const qualifierSuffixMatch = params.qualifier.match(/_([a-z0-9-]+)$/i);
  if (qualifierSuffixMatch) {
    return `openclaw-identity-${qualifierSuffixMatch[1]}`;
  }

  return "openclaw-identity";
}

export async function resolveAgentCoreRuntimeTarget(
  params: ResolveAgentCoreRuntimeTargetParams,
): Promise<ResolvedAgentCoreRuntimeTarget> {
  const runtimeName = params.runtimeName?.trim() ?? "";
  const endpointName =
    params.endpointName?.trim() || DEFAULT_AGENTCORE_RUNTIME_ENDPOINT_NAME;
  const runtimeArn = params.runtimeArn?.trim() ?? "";
  const qualifier = params.qualifier?.trim() ?? "";

  if (runtimeName) {
    const client = new BedrockAgentCoreControlClient({ region: params.region });
    const runtime = selectAgentRuntime(
      await listAllAgentRuntimes(client),
      runtimeName,
    );
    const resolvedRuntimeId = runtime.agentRuntimeId;
    const resolvedRuntimeArn = runtime.agentRuntimeArn;

    if (!resolvedRuntimeId || !resolvedRuntimeArn) {
      throw new Error(
        `AgentCore runtime ${runtimeName} is missing a runtime ID or ARN.`,
      );
    }

    const endpoint = selectAgentRuntimeEndpoint(
      await listAllAgentRuntimeEndpoints(client, resolvedRuntimeId),
      endpointName,
    );
    const resolvedQualifier = endpoint.agentRuntimeEndpointArn;

    if (!resolvedQualifier) {
      throw new Error(
        `AgentCore runtime endpoint ${endpointName} for ${runtimeName} is missing an endpoint ARN.`,
      );
    }

    return {
      runtimeArn: resolvedRuntimeArn,
      qualifier: resolvedQualifier,
      runtimeId: resolvedRuntimeId,
      runtimeName,
      endpointName,
    };
  }

  if (runtimeArn && qualifier) {
    return {
      runtimeArn,
      qualifier,
      runtimeId: "",
      runtimeName: "",
      endpointName: parseEndpointNameFromQualifier(qualifier) ?? endpointName,
    };
  }

  if (runtimeArn || qualifier) {
    throw new Error(
      "Set both AGENTCORE_RUNTIME_ARN and AGENTCORE_RUNTIME_ENDPOINT_ID, or use AGENTCORE_RUNTIME_NAME instead.",
    );
  }

  throw new Error(
    "AGENTCORE_RUNTIME_NAME is required for agentcore mode unless both AGENTCORE_RUNTIME_ARN and AGENTCORE_RUNTIME_ENDPOINT_ID are provided.",
  );
}

export function selectAgentRuntime(
  runtimes: AgentRuntimeSummary[],
  runtimeName: string,
): AgentRuntimeSummary {
  const matches = runtimes.filter(
    (runtime) =>
      runtime.agentRuntimeName === runtimeName &&
      typeof runtime.agentRuntimeId === "string" &&
      runtime.agentRuntimeId.length > 0 &&
      typeof runtime.agentRuntimeArn === "string" &&
      runtime.agentRuntimeArn.length > 0,
  );

  if (matches.length === 0) {
    throw new Error(
      `Could not find an AgentCore runtime named ${runtimeName}.`,
    );
  }

  const readyMatches = matches.filter((runtime) => runtime.status === "READY");
  if (readyMatches.length === 0) {
    throw new Error(
      `Found AgentCore runtime named ${runtimeName}, but none are READY.`,
    );
  }

  return [...readyMatches].sort(compareAgentRuntimes)[0];
}

export function selectAgentRuntimeEndpoint(
  endpoints: AgentRuntimeEndpointSummary[],
  endpointName: string,
): AgentRuntimeEndpointSummary {
  const matches = endpoints.filter(
    (endpoint) =>
      endpoint.name === endpointName &&
      typeof endpoint.agentRuntimeEndpointArn === "string" &&
      endpoint.agentRuntimeEndpointArn.length > 0,
  );

  if (matches.length === 0) {
    throw new Error(
      `Could not find an AgentCore runtime endpoint named ${endpointName}.`,
    );
  }

  const readyMatches = matches.filter(
    (endpoint) => endpoint.status === "READY",
  );
  if (readyMatches.length === 0) {
    throw new Error(
      `Found AgentCore runtime endpoint named ${endpointName}, but none are READY.`,
    );
  }

  return [...readyMatches].sort(compareAgentRuntimeEndpoints)[0];
}

function compareAgentRuntimes(
  a: AgentRuntimeSummary,
  b: AgentRuntimeSummary,
): number {
  const versionDifference =
    parseRuntimeVersion(b.agentRuntimeVersion) -
    parseRuntimeVersion(a.agentRuntimeVersion);
  if (versionDifference !== 0) {
    return versionDifference;
  }

  return compareDatesDescending(a.lastUpdatedAt, b.lastUpdatedAt);
}

function compareAgentRuntimeEndpoints(
  a: AgentRuntimeEndpointSummary,
  b: AgentRuntimeEndpointSummary,
): number {
  return compareDatesDescending(a.lastUpdatedAt, b.lastUpdatedAt);
}

function compareDatesDescending(a?: Date, b?: Date): number {
  return (b?.getTime() ?? 0) - (a?.getTime() ?? 0);
}

function parseRuntimeVersion(version: string | undefined): number {
  const parsedVersion = Number(version);
  return Number.isFinite(parsedVersion) ? parsedVersion : 0;
}

function parseEndpointNameFromQualifier(qualifier: string): string | null {
  const match = qualifier.match(/\/runtime-endpoint\/([^/]+)$/);
  return match?.[1] ?? null;
}

async function listAllAgentRuntimes(
  client: BedrockAgentCoreControlClient,
): Promise<AgentRuntimeSummary[]> {
  const runtimes: AgentRuntimeSummary[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new ListAgentRuntimesCommand({
        maxResults: 50,
        nextToken,
      }),
    );
    runtimes.push(...(response.agentRuntimes ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return runtimes;
}

async function listAllAgentRuntimeEndpoints(
  client: BedrockAgentCoreControlClient,
  runtimeId: string,
): Promise<AgentRuntimeEndpointSummary[]> {
  const endpoints: AgentRuntimeEndpointSummary[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new ListAgentRuntimeEndpointsCommand({
        agentRuntimeId: runtimeId,
        maxResults: 50,
        nextToken,
      }),
    );
    endpoints.push(...(response.runtimeEndpoints ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return endpoints;
}
