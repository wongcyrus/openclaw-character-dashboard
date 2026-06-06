import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Table, AttributeType, BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { Duration, Stack, RemovalPolicy, CfnOutput } from "aws-cdk-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env.local or .env
dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env") });

export class DashboardServerlessStack extends Stack {
  constructor(scope: Construct, id: string, props?: any) {
    super(scope, id, props);

    // 1. S3 Website Bucket (Private, accessed via CloudFront)
    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // 2. DynamoDB for WebSocket Connections and State
    const connectionsTable = new Table(this, "ConnectionsTable", {
      tableName: "OpenClawDashboardConnections",
      partitionKey: { name: "connectionId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 3. S3 Bucket for Shared Resource Wall Files
    const sharedFilesBucket = new s3.Bucket(this, "SharedFilesBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [{
        allowedHeaders: ["*"],
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: ["*"],
        maxAge: 3000,
      }],
    });

    // 4. Lambda Backend
    const lambdaFunction = new nodejs.NodejsFunction(this, "BackendLambda", {
      entry: path.join(__dirname, "../server/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        SHARED_FILES_BUCKET: sharedFilesBucket.bucketName,
        OPENCLAW_BACKEND_MODE: process.env.OPENCLAW_BACKEND_MODE || "local",
        GATEWAY_HOST: process.env.GATEWAY_HOST || "127.0.0.1",
        AGENTCORE_REGION: process.env.AGENTCORE_REGION || "",
        AGENTCORE_RUNTIME_NAME: process.env.AGENTCORE_RUNTIME_NAME || "",
        AGENTCORE_RUNTIME_ENDPOINT_NAME:
          process.env.AGENTCORE_RUNTIME_ENDPOINT_NAME || "",
        AGENTCORE_RUNTIME_ARN: process.env.AGENTCORE_RUNTIME_ARN || "",
        AGENTCORE_RUNTIME_ENDPOINT_ID: process.env.AGENTCORE_RUNTIME_ENDPOINT_ID || "",
        AGENTCORE_ACTOR_ID: process.env.AGENTCORE_ACTOR_ID || "",
        AGENTCORE_CHANNEL: process.env.AGENTCORE_CHANNEL || "",
        AGENTCORE_IDENTITY_TABLE_NAME:
          process.env.AGENTCORE_IDENTITY_TABLE_NAME || "",
        AGENTCORE_USER_ID: process.env.AGENTCORE_USER_ID || "",
        AGENTCORE_RUNTIME_SESSION_ID:
          process.env.AGENTCORE_RUNTIME_SESSION_ID || "",
      },
    });

    connectionsTable.grantReadWriteData(lambdaFunction);
    sharedFilesBucket.grantRead(lambdaFunction);

    // 5. API Gateway REST API
    const restApi = new apigateway.RestApi(this, "RestApi", {
      restApiName: "OpenClaw Dashboard REST API",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(lambdaFunction);
    const apiResource = restApi.root.addResource("api");
    apiResource.addProxy({
      defaultIntegration: lambdaIntegration,
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.NONE,
      },
    });

    // 6. API Gateway WebSocket API
    const webSocketApi = new apigatewayv2.CfnApi(this, "WebSocketApi", {
      name: "OpenClawDashboardWebSocketApi",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });

    const wsIntegration = new apigatewayv2.CfnIntegration(this, "WsIntegration", {
      apiId: webSocketApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${lambdaFunction.functionArn}/invocations`,
    });

    const connectRoute = new apigatewayv2.CfnRoute(this, "ConnectRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$connect",
      authorizationType: "NONE",
      target: `integrations/${wsIntegration.ref}`,
    });

    const disconnectRoute = new apigatewayv2.CfnRoute(this, "DisconnectRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$disconnect",
      target: `integrations/${wsIntegration.ref}`,
    });

    const defaultRoute = new apigatewayv2.CfnRoute(this, "DefaultRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$default",
      target: `integrations/${wsIntegration.ref}`,
    });

    const deployment = new apigatewayv2.CfnDeployment(this, "WsDeployment", {
      apiId: webSocketApi.ref,
    });

    const stage = new apigatewayv2.CfnStage(this, "WsStage", {
      apiId: webSocketApi.ref,
      stageName: "prod",
      deploymentId: deployment.ref,
      autoDeploy: true,
    });

    deployment.node.addDependency(connectRoute);
    deployment.node.addDependency(disconnectRoute);
    deployment.node.addDependency(defaultRoute);

    lambdaFunction.addPermission("WsInvokePermission", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.ref}/*`,
    });

    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.ref}/${stage.stageName}/*`],
    }));

    lambdaFunction.addEnvironment("WEBSOCKET_ENDPOINT", `https://${webSocketApi.ref}.execute-api.${this.region}.amazonaws.com/${stage.stageName}`);

    // Grant permissions to invoke Bedrock AgentCore if in agentcore mode
    if (process.env.OPENCLAW_BACKEND_MODE === "agentcore") {
      lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
          "bedrock-agentcore:ListAgentRuntimes",
          "bedrock-agentcore:ListAgentRuntimeEndpoints",
          "dynamodb:GetItem",
        ],
        resources: ["*"], 
      }));
    }

    // 7. CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    const apiOrigin = new origins.RestApiOrigin(restApi);
    distribution.addBehavior("/api/*", apiOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });

    // 8. Deployment: Shared Files (Resource Wall)
    new s3deploy.BucketDeployment(this, "DeploySharedFiles", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../shared"))],
      destinationBucket: sharedFilesBucket,
      prune: false,
    });

    // 9. Deployment: Frontend Assets
    new s3deploy.BucketDeployment(this, "DeployFrontend", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../dist")),
        s3deploy.Source.jsonData("config.json", {
          apiBaseUrl: `https://${distribution.distributionDomainName}/api`,
          webSocketUrl: `wss://${webSocketApi.ref}.execute-api.${this.region}.amazonaws.com/${stage.stageName}`,
          availableAssetPacks: ["frieren", "tamon"],
          defaultAssetPack: "frieren",
        }),
      ],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: false, // Don't delete asset packs
    });

    // 10. Deployment: Asset Packs (to specific prefixes)
    new s3deploy.BucketDeployment(this, "DeployAssetPackFrieren", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../public_frieren"))],
      destinationBucket: websiteBucket,
      destinationKeyPrefix: "assets/frieren",
      distribution,
      distributionPaths: ["/assets/frieren/*"],
      prune: false,
    });

    new s3deploy.BucketDeployment(this, "DeployAssetPackTamon", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../public_tamon_b_side"))],
      destinationBucket: websiteBucket,
      destinationKeyPrefix: "assets/tamon",
      distribution,
      distributionPaths: ["/assets/tamon/*"],
      prune: false,
    });

    new CfnOutput(this, "ServiceUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "SharedBucket", { value: sharedFilesBucket.bucketName });
  }
}
