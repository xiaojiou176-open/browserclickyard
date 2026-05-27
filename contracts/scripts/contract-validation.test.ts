import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import YAML from "../../scripts/lib/yaml-loader.mjs";

type OpenApiSpec = {
  paths?: Record<string, Record<string, Record<string, unknown>>>;
  components?: {
    schemas?: Record<string, unknown>;
  };
};

type Operation = {
  operationId: string;
  method: string;
  path: string;
};

const openapiPath = resolve("contracts/openapi/api.yaml");
const generatedClientPath = resolve("tests/web-harness/src/api-gen/client.ts");
const generatedAutomationApiPath = resolve("tests/web-harness/src/api-gen/api/automation.ts");
const generatedHealthApiPath = resolve("tests/web-harness/src/api-gen/api/health.ts");
const generatedCommandTowerApiPath = resolve("tests/web-harness/src/api-gen/api/command-tower.ts");
const generatedMswPath = resolve("tests/web-harness/msw/handlers.ts");

function loadSpec(): OpenApiSpec {
  return YAML.parse(readFileSync(openapiPath, "utf8")) as OpenApiSpec;
}

function readRefName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref !== "string") return null;
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  return match ? match[1] : null;
}

function getOperation(spec: OpenApiSpec, method: string, path: string): Record<string, unknown> {
  const operation = spec.paths?.[path]?.[method.toLowerCase()];
  assert.ok(operation, `Missing operation ${method.toUpperCase()} ${path}`);
  return operation;
}

function getOperations(spec: OpenApiSpec): Operation[] {
  const operations: Operation[] = [];
  const httpMethods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "options",
    "head",
    "trace",
  ]);
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!httpMethods.has(method.toLowerCase())) {
        continue;
      }
      const opId = (operation.operationId as string | undefined)?.trim();
      assert.ok(opId, `operationId is required for ${method.toUpperCase()} ${path}`);
      operations.push({
        operationId: opId!,
        method: method.toUpperCase(),
        path,
      });
    }
  }
  return operations;
}

function getResponseSchemaRef(
  operation: Record<string, unknown>,
  statusCode: string,
): string | null {
  const responses = operation.responses as Record<string, unknown> | undefined;
  const status = responses?.[statusCode] as Record<string, unknown> | undefined;
  const content = status?.content as Record<string, unknown> | undefined;
  const appJson = content?.["application/json"] as Record<string, unknown> | undefined;
  return readRefName(appJson?.schema);
}

function getRequestSchemaRef(operation: Record<string, unknown>): string | null {
  const requestBody = operation.requestBody as Record<string, unknown> | undefined;
  const content = requestBody?.content as Record<string, unknown> | undefined;
  const appJson = content?.["application/json"] as Record<string, unknown> | undefined;
  return readRefName(appJson?.schema);
}

function getResponseStatusCodes(operation: Record<string, unknown>): string[] {
  const responses = operation.responses as Record<string, unknown> | undefined;
  return Object.keys(responses ?? {});
}

function getSchema(spec: OpenApiSpec, name: string): Record<string, unknown> {
  const schema = spec.components?.schemas?.[name];
  assert.ok(schema, `Missing schema: ${name}`);
  return schema as Record<string, unknown>;
}

function parseGeneratedOperations(source: string, constName: string): Operation[] {
  const sourceFile = ts.createSourceFile(
    `${constName}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let operationsArray: ts.ArrayLiteralExpression | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== constName) {
        continue;
      }
      const initializer = declaration.initializer;
      if (
        initializer &&
        ts.isAsExpression(initializer) &&
        ts.isArrayLiteralExpression(initializer.expression)
      ) {
        operationsArray = initializer.expression;
      } else if (initializer && ts.isArrayLiteralExpression(initializer)) {
        operationsArray = initializer;
      }
    }
  }
  assert.ok(operationsArray, `Generated file must export ${constName}`);
  const readStringProp = (entry: ts.ObjectLiteralExpression, key: string): string | undefined => {
    const property = entry.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) &&
        ((ts.isIdentifier(item.name) && item.name.text === key) ||
          (ts.isStringLiteral(item.name) && item.name.text === key)),
    );
    if (!property) {
      return undefined;
    }
    if (
      ts.isStringLiteral(property.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(property.initializer)
    ) {
      return property.initializer.text;
    }
    return undefined;
  };
  const entries: Operation[] = [];
  for (const element of operationsArray.elements) {
    assert.ok(
      ts.isObjectLiteralExpression(element),
      `Invalid operation entry in ${constName}: expected object`,
    );
    const operationId = readStringProp(element, "operationId");
    const method = readStringProp(element, "method");
    const path = readStringProp(element, "path");
    assert.ok(
      operationId && method && path,
      `Invalid operation entry in ${constName}: missing required keys`,
    );
    entries.push({ operationId, method, path });
  }
  assert.ok(entries.length > 0, `Generated operation list ${constName} is empty or malformed`);
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("OpenAPI covers run/report/automation core contract schemas", () => {
  const spec = loadSpec();

  const requiredPaths = [
    "GET /api/automation/commands",
    "GET /api/automation/tasks",
    "GET /api/automation/tasks/{task_id}",
    "POST /api/automation/run",
    "POST /api/automation/tasks/{task_id}/cancel",
    "GET /api/runs",
    "POST /api/runs",
    "GET /api/runs/{run_id}",
    "POST /api/runs/{run_id}/otp",
    "POST /api/runs/{run_id}/resume",
    "POST /api/runs/{run_id}/cancel",
    "POST /api/templates/promote",
    "GET /api/templates/{template_id}/history",
    "POST /api/templates/{template_id}/fork-version",
    "POST /api/templates/{template_id}/mark-recommended",
    "GET /api/proof/campaigns",
    "POST /api/proof/campaigns",
    "GET /api/proof/campaigns/{campaign_id}",
    "POST /api/proof/campaigns/{campaign_id}/diff",
    "POST /api/proof/runs/compare",
    "GET /api/proof/runs/{run_id}/ai-review",
    "GET /api/proof/templates/{template_id}/feasibility",
    "GET /health/diagnostics",
  ];

  for (const entry of requiredPaths) {
    const [method, ...pathParts] = entry.split(" ");
    getOperation(spec, method, pathParts.join(" "));
  }

  const requiredSchemas = [
    "AutomationCommandListResponse",
    "AutomationTaskListResponse",
    "AutomationTaskResponse",
    "AutomationRunRequest",
    "AutomationRunResponse",
    "AutomationTask",
    "RunCreateRequest",
    "RunOtpSubmitRequest",
    "RunResumeRequest",
    "ManualGateAction",
    "RunListResponse",
    "RunResponse",
    "RunCancelResponse",
    "Run",
    "RunStatus",
    "ReportSummary",
    "ReportCheck",
    "TemplatePromoteRequest",
    "TemplateVersionForkRequest",
    "TemplateHistoryResponse",
    "ProofCampaignRecord",
    "ProofCampaignListResponse",
    "ProofCampaignResponse",
    "ProofCampaignCreateRequest",
    "ProofCampaignDiffRequest",
    "ProofCampaignDiffResponse",
    "ProofRunCompareRequest",
    "ProofRunCompareResponse",
    "RunAiReviewProjectionResponse",
    "DiagnosticsResponse",
    "DiagnosticsIndex",
  ];

  const schemaNames = Object.keys(spec.components?.schemas ?? {});
  for (const schema of requiredSchemas) {
    assert.ok(schemaNames.includes(schema), `Missing schema: ${schema}`);
  }

  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/automation/commands"), "200"),
    "AutomationCommandListResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/automation/tasks"), "200"),
    "AutomationTaskListResponse",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/automation/run")),
    "AutomationRunRequest",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "POST", "/api/automation/run"), "200"),
    "AutomationRunResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/runs"), "200"),
    "RunListResponse",
  );
  assert.equal(getRequestSchemaRef(getOperation(spec, "POST", "/api/runs")), "RunCreateRequest");
  assert.equal(getResponseSchemaRef(getOperation(spec, "POST", "/api/runs"), "200"), "RunResponse");
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/runs/{run_id}"), "200"),
    "RunResponse",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/runs/{run_id}/otp")),
    "RunOtpSubmitRequest",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/runs/{run_id}/resume")),
    "RunResumeRequest",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "POST", "/api/runs/{run_id}/otp"), "200"),
    "RunResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "POST", "/api/runs/{run_id}/resume"), "200"),
    "RunResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "POST", "/api/runs/{run_id}/cancel"), "200"),
    "RunResponse",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/templates/promote")),
    "TemplatePromoteRequest",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/templates/{template_id}/history"), "200"),
    "TemplateHistoryResponse",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/templates/{template_id}/fork-version")),
    "TemplateVersionForkRequest",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/proof/campaigns"), "200"),
    "ProofCampaignListResponse",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/proof/campaigns")),
    "ProofCampaignCreateRequest",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "POST", "/api/proof/campaigns"), "200"),
    "ProofCampaignResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/proof/campaigns/{campaign_id}"), "200"),
    "ProofCampaignResponse",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/proof/campaigns/{campaign_id}/diff")),
    "ProofCampaignDiffRequest",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "POST", "/api/proof/campaigns/{campaign_id}/diff"), "200"),
    "ProofCampaignDiffResponse",
  );
  assert.equal(
    getRequestSchemaRef(getOperation(spec, "POST", "/api/proof/runs/compare")),
    "ProofRunCompareRequest",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "POST", "/api/proof/runs/compare"), "200"),
    "ProofRunCompareResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/proof/runs/{run_id}/ai-review"), "200"),
    "RunAiReviewProjectionResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/api/proof/templates/{template_id}/feasibility"), "200"),
    "TargetFeasibilityResponse",
  );
  assert.equal(
    getResponseSchemaRef(getOperation(spec, "GET", "/health/diagnostics"), "200"),
    "DiagnosticsResponse",
  );
});

test("critical failure-path contract is explicitly modeled for health/runs/computer-use/automation", () => {
  const spec = loadSpec();

  const previewAction = getOperation(
    spec,
    "POST",
    "/api/computer-use/sessions/{session_id}/preview",
  );
  const confirmAction = getOperation(
    spec,
    "POST",
    "/api/computer-use/sessions/{session_id}/confirm/{action_id}",
  );
  const executeAction = getOperation(
    spec,
    "POST",
    "/api/computer-use/sessions/{session_id}/execute/{action_id}",
  );
  const readEvidence = getOperation(
    spec,
    "GET",
    "/api/computer-use/sessions/{session_id}/evidence",
  );

  assert.ok(
    getResponseStatusCodes(previewAction).includes("403"),
    "computer-use preview must declare 403 forbidden path",
  );
  assert.ok(
    getResponseStatusCodes(confirmAction).includes("403"),
    "computer-use confirm must declare 403 forbidden path",
  );
  assert.ok(
    getResponseStatusCodes(executeAction).includes("403"),
    "computer-use execute must declare 403 forbidden path",
  );
  assert.ok(
    getResponseStatusCodes(executeAction).includes("409"),
    "computer-use execute must declare 409 state-conflict path",
  );
  assert.ok(
    getResponseStatusCodes(readEvidence).includes("403"),
    "computer-use evidence must declare 403 forbidden path",
  );

  const runStatus = getSchema(spec, "RunStatus");
  const runStatusEnum = (runStatus.enum as string[] | undefined) ?? [];
  assert.ok(runStatusEnum.includes("failed"), "RunStatus must include failed for run failure path");
  assert.ok(
    runStatusEnum.includes("cancelled"),
    "RunStatus must include cancelled for cancellation path",
  );
  assert.ok(
    runStatusEnum.includes("waiting_otp"),
    "RunStatus must include waiting_otp for OTP manual-gate path",
  );
  assert.ok(
    runStatusEnum.includes("waiting_user"),
    "RunStatus must include waiting_user for provider challenge path",
  );

  const automationTask = getSchema(spec, "AutomationTask");
  const automationStatusEnum = ((
    (automationTask.properties as Record<string, unknown> | undefined)?.status as
      | Record<string, unknown>
      | undefined
  )?.enum ?? []) as string[];
  assert.ok(
    automationStatusEnum.includes("failed"),
    "AutomationTask.status must include failed path",
  );
  assert.ok(
    automationStatusEnum.includes("cancelled"),
    "AutomationTask.status must include cancelled path",
  );

  const healthTaskCounts = getSchema(spec, "HealthTaskCounts");
  const healthRequired = ((healthTaskCounts.required ?? []) as string[]).sort();
  assert.ok(healthRequired.includes("failed"), "HealthTaskCounts must track failed tasks");
  assert.ok(healthRequired.includes("cancelled"), "HealthTaskCounts must track cancelled tasks");

  const alertsResponse = getSchema(spec, "AlertsResponse");
  const alertsStateEnum = ((
    (alertsResponse.properties as Record<string, unknown> | undefined)?.state as
      | Record<string, unknown>
      | undefined
  )?.enum ?? []) as string[];
  assert.ok(
    alertsStateEnum.includes("degraded"),
    "AlertsResponse.state must include degraded health failure path",
  );
});

test("automation commands/run schemas and examples align with backend contract", () => {
  const spec = loadSpec();
  const automationCommand = getSchema(spec, "AutomationCommand");
  const commandRequired = ((automationCommand.required ?? []) as string[]).slice().sort();
  assert.deepEqual(
    commandRequired,
    ["accepts_env", "command_id", "description", "tags", "title"].sort(),
  );

  const automationCommandProps =
    (automationCommand.properties as Record<string, unknown> | undefined) ?? {};
  assert.ok(automationCommandProps.command_id, "AutomationCommand.command_id is required");
  assert.ok(automationCommandProps.title, "AutomationCommand.title is required");
  assert.ok(automationCommandProps.tags, "AutomationCommand.tags is required");
  assert.equal(
    (automationCommandProps.accepts_env as { type?: string } | undefined)?.type,
    "boolean",
  );

  const runRequest = getSchema(spec, "AutomationRunRequest");
  const runRequestProps = (runRequest.properties as Record<string, unknown> | undefined) ?? {};
  assert.ok(runRequestProps.command, "AutomationRunRequest.command must exist");
  assert.ok(
    runRequestProps.command_id,
    "AutomationRunRequest.command_id compatibility alias must exist",
  );
  assert.ok(runRequestProps.params, "AutomationRunRequest.params must exist");
  assert.ok(runRequestProps.env, "AutomationRunRequest.env compatibility field must exist");
  assert.equal(
    (runRequestProps.command_id as { deprecated?: boolean } | undefined)?.deprecated,
    true,
  );
  assert.equal((runRequestProps.env as { deprecated?: boolean } | undefined)?.deprecated, true);
  assert.equal((runRequestProps.env as { maxProperties?: number } | undefined)?.maxProperties, 32);
  assert.equal(readRefName(runRequestProps.params), "AutomationRunParams");

  const runParams = getSchema(spec, "AutomationRunParams");
  assert.equal((runParams.additionalProperties as boolean | undefined) ?? true, false);
  const runParamProps = (runParams.properties as Record<string, unknown> | undefined) ?? {};
  assert.ok(runParamProps.BASE_URL, "AutomationRunParams.BASE_URL must exist");
  assert.ok(runParamProps.FLOW_STEP_ID, "AutomationRunParams.FLOW_STEP_ID must exist");

  const automationTask = getSchema(spec, "AutomationTask");
  const taskRequired = ((automationTask.required ?? []) as string[]).slice().sort();
  assert.ok(taskRequired.includes("command_id"), "AutomationTask requires command_id");
  assert.ok(taskRequired.includes("attempt"), "AutomationTask requires attempt");
  assert.ok(taskRequired.includes("max_attempts"), "AutomationTask requires max_attempts");
  assert.ok(taskRequired.includes("output_tail"), "AutomationTask requires output_tail");
  const taskProps = (automationTask.properties as Record<string, unknown> | undefined) ?? {};
  assert.ok(taskProps.requested_by, "AutomationTask.requested_by should be modeled");
  assert.ok(taskProps.message, "AutomationTask.message should be modeled");

  const commandsOperation = getOperation(spec, "GET", "/api/automation/commands");
  const commands200 = ((commandsOperation.responses as Record<string, unknown> | undefined)?.[
    "200"
  ] ?? {}) as Record<string, unknown>;
  const commandsExample = ((
    ((commands200.content as Record<string, unknown> | undefined)?.["application/json"] ??
      {}) as Record<string, unknown>
  ).example ?? null) as Record<string, unknown> | null;
  assert.ok(commandsExample, "GET /api/automation/commands should include a response example");

  const runOperation = getOperation(spec, "POST", "/api/automation/run");
  const runRequestBody = (runOperation.requestBody as Record<string, unknown> | undefined) ?? {};
  const runRequestJson = ((runRequestBody.content as Record<string, unknown> | undefined)?.[
    "application/json"
  ] ?? {}) as Record<string, unknown>;
  const runExamples = (runRequestJson.examples as Record<string, unknown> | undefined) ?? {};
  assert.ok(
    runExamples.paramsPreferred,
    "POST /api/automation/run should include paramsPreferred example",
  );
  assert.ok(
    runExamples.deprecatedEnvCompat,
    "POST /api/automation/run should include deprecatedEnvCompat example",
  );
});

test("operationId is unique and generated artifacts match OpenAPI operations", () => {
  const spec = loadSpec();
  const operations = getOperations(spec).sort((a, b) => a.operationId.localeCompare(b.operationId));

  const opIds = operations.map((op) => op.operationId);
  const uniqueOpIds = new Set(opIds);
  assert.equal(uniqueOpIds.size, opIds.length, "operationId must be unique across the API spec");

  const generatedClient = readFileSync(generatedClientPath, "utf8");
  const generatedAutomationApi = readFileSync(generatedAutomationApiPath, "utf8");
  const generatedHealthApi = readFileSync(generatedHealthApiPath, "utf8");
  const generatedCommandTowerApi = readFileSync(generatedCommandTowerApiPath, "utf8");
  const generatedMsw = readFileSync(generatedMswPath, "utf8");

  assert.match(generatedClient, /export const API_OPERATIONS = \[/);
  assert.match(generatedClient, /\.\.\.HEALTH_API_OPERATIONS/);
  assert.match(generatedClient, /\.\.\.AUTOMATION_API_OPERATIONS/);
  assert.match(generatedClient, /\.\.\.COMMAND_TOWER_API_OPERATIONS/);

  const generatedOperations = [
    ...parseGeneratedOperations(generatedHealthApi, "HEALTH_API_OPERATIONS"),
    ...parseGeneratedOperations(generatedAutomationApi, "AUTOMATION_API_OPERATIONS"),
    ...parseGeneratedOperations(generatedCommandTowerApi, "COMMAND_TOWER_API_OPERATIONS"),
  ];
  const generatedSorted = generatedOperations.sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );

  assert.deepEqual(
    generatedSorted.map((op) => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
    })),
    operations,
  );

  for (const op of operations) {
    assert.match(generatedMsw, new RegExp(`operationId:\\s*"${escapeRegExp(op.operationId)}"`));
    const mswPath = op.path.replace(/\{([a-zA-Z0-9_]+)\}/g, ":$1");
    assert.match(generatedMsw, new RegExp(`"${escapeRegExp(mswPath)}"`));
  }
});

test("generated client replaces path placeholders with function parameters", () => {
  const generatedAutomationApi = readFileSync(generatedAutomationApiPath, "utf8");

  const fetchUrlSegments = Array.from(
    generatedAutomationApi.matchAll(/requestJson\(baseUrl, `([^`]+)`/g),
    (match) => match[1],
  );
  for (const urlSegment of fetchUrlSegments) {
    const withoutTemplateExpressions = urlSegment.replace(/\$\{[^}]+\}/g, "");
    assert.ok(
      !/\{[a-zA-Z0-9_]+\}/.test(withoutTemplateExpressions),
      `generated fetch URL must not keep placeholders: ${urlSegment}`,
    );
  }

  assert.match(
    generatedAutomationApi,
    /getAutomationTask\(\s*baseUrl: string,\s*pathParams: \{ task_id: string \},\s*init\?: RequestInit\s*,?\s*\)/,
  );
  assert.match(
    generatedAutomationApi,
    /getRun\(\s*baseUrl: string,\s*pathParams: \{ run_id: string \},\s*init\?: RequestInit\s*,?\s*\)/,
  );
  assert.match(
    generatedAutomationApi,
    /submitRunOtp\(\s*baseUrl: string,\s*pathParams: \{ run_id: string \},\s*init\?: RequestInit\s*,?\s*\)/,
  );
  assert.match(
    generatedAutomationApi,
    /cancelRun\(\s*baseUrl: string,\s*pathParams: \{ run_id: string \},\s*init\?: RequestInit\s*,?\s*\)/,
  );

  assert.match(generatedAutomationApi, /encodeURIComponent\(pathParams\.task_id\)/);
  assert.match(generatedAutomationApi, /encodeURIComponent\(pathParams\.run_id\)/);
});
