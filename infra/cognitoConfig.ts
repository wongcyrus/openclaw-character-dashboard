import { execFileSync } from "node:child_process";

import { z } from "zod";

export const COGNITO_STACK_NAME = "aws-agentic-robotics";

export const CognitoConfigSchema = z.object({
  region: z.string().min(1),
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
});

export type CognitoConfig = z.infer<typeof CognitoConfigSchema>;

const StackOutputsSchema = z.array(
  z.object({
    OutputKey: z.string(),
    OutputValue: z.string(),
  }),
);

export function loadCognitoConfig(region: string): CognitoConfig {
  const outputs = StackOutputsSchema.parse(
    JSON.parse(
      execFileSync(
        "aws",
        [
          "cloudformation",
          "describe-stacks",
          "--stack-name",
          COGNITO_STACK_NAME,
          "--region",
          region,
          "--query",
          "Stacks[0].Outputs",
          "--output",
          "json",
          "--no-cli-pager",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ),
    ),
  );
  const values = Object.fromEntries(
    outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );
  const result = CognitoConfigSchema.safeParse({
    region: values.CognitoRegion,
    userPoolId: values.CognitoUserPoolId,
    clientId: values.CognitoUserPoolClientId,
  });

  if (!result.success) {
    throw new Error(
      `Stack ${COGNITO_STACK_NAME} must expose non-empty CognitoRegion, ` +
        `CognitoUserPoolId, and CognitoUserPoolClientId outputs: ${result.error.message}`,
    );
  }

  return result.data;
}
