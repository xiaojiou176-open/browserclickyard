import { fail } from "k6";
import { assertChecks, parseJsonBody, requireNonEmptyString } from "../scenario-lib/assertions.js";
import { makeIterationSuffix, resolveJourneyStartUrl } from "../scenario-lib/config.js";
import { getRequest, postJson } from "../scenario-lib/http-client.js";

export const universalAutomationScenario = {
  name: "universal_automation",
  description: "登录(会话启动) -> 搜索(会话列表) -> 关键操作(Flow+Template) -> 提交(Run)",
  execute(context) {
    const config = context.config;
    if (!config.credentials.automationToken) {
      fail("universal_automation scenario requires AUTOMATION_API_TOKEN/AUTOMATION_API_TOKEN");
    }

    const suffix = makeIterationSuffix(context.vu, context.iter);
    const dataset = config.dataset.universal;
    const startUrl = resolveJourneyStartUrl(config, dataset.startUrl);

    const startSessionRes = postJson(config, "/api/sessions/start", {
      start_url: startUrl,
      mode: String(dataset.mode || "manual"),
    });
    const startSessionJson = parseJsonBody(startSessionRes, "universal login start session");
    const sessionId = requireNonEmptyString(startSessionJson.session_id, "universal session_id");
    assertChecks(
      startSessionRes,
      {
        "universal/login start-session status is 200": (r) => r.status === 200,
      },
      "universal login step failed",
    );

    const searchLimit = Number(dataset.searchLimit || 30);
    const listSessionsRes = getRequest(config, `/api/sessions?limit=${searchLimit}`);
    const listSessionsJson = parseJsonBody(listSessionsRes, "universal search sessions");
    const sessions = Array.isArray(listSessionsJson.sessions) ? listSessionsJson.sessions : [];
    assertChecks(
      listSessionsRes,
      {
        "universal/search sessions status is 200": (r) => r.status === 200,
        "universal/search session created is discoverable": () =>
          sessions.some((item) => item && item.session_id === sessionId),
      },
      "universal search step failed",
    );

    const flowName = `${String(dataset.flowNamePrefix || "k6-flow")}-${suffix}`;
    const createFlowRes = postJson(config, "/api/flows", {
      session_id: sessionId,
      start_url: startUrl,
      source_event_count: Number(dataset.sourceEventCount || 4),
      steps: [
        { step_id: "s1", action: "navigate", url: startUrl },
        { step_id: "s2", action: "type", value_ref: "${params.email}" },
        { step_id: "s3", action: "type", value_ref: "${secrets.password}" },
        { step_id: "s4", action: "click", value_ref: flowName },
      ],
    });
    const createFlowJson = parseJsonBody(createFlowRes, "universal critical create flow");
    const flowId = requireNonEmptyString(createFlowJson.flow_id, "universal flow_id");
    assertChecks(
      createFlowRes,
      {
        "universal/critical create-flow status is 200": (r) => r.status === 200,
      },
      "universal critical flow creation failed",
    );

    const templateName = `${String(dataset.templateNamePrefix || "k6-template")}-${suffix}`;
    const createTemplateRes = postJson(config, "/api/templates", {
      flow_id: flowId,
      name: templateName,
      params_schema: [
        { key: "email", type: "email", required: true },
        { key: "password", type: "secret", required: true },
      ],
      defaults: {
        email: `k6-default-${suffix}@${String(dataset.runEmailDomain || "example.com")}`,
        password: "${secrets.password}",
      },
      policies: { retries: 1, timeout_seconds: 90, otp: { required: false, provider: "manual" } },
    });
    const createTemplateJson = parseJsonBody(
      createTemplateRes,
      "universal critical create template",
    );
    const templateId = requireNonEmptyString(
      createTemplateJson.template_id,
      "universal template_id",
    );
    assertChecks(
      createTemplateRes,
      {
        "universal/critical create-template status is 200": (r) => r.status === 200,
      },
      "universal critical template creation failed",
    );

    const runEmail = `k6-run-${suffix}@${String(dataset.runEmailDomain || "example.com")}`;
    const submitRunRes = postJson(config, "/api/runs", {
      template_id: templateId,
      params: { email: runEmail, password: config.credentials.password },
    });
    const submitRunJson = parseJsonBody(submitRunRes, "universal submit create run");
    const runId = requireNonEmptyString(submitRunJson.run?.run_id, "universal run_id");
    assertChecks(
      submitRunRes,
      {
        "universal/submit create-run status is 200": (r) => r.status === 200,
        "universal/submit create-run has task": (r) => typeof r.json("run.task_id") === "string",
      },
      "universal submit flow failed",
    );

    const getRunRes = getRequest(config, `/api/runs/${runId}`);
    assertChecks(
      getRunRes,
      {
        "universal/submit fetch-run status is 200": (r) => r.status === 200,
        "universal/submit fetch-run id matches": (r) => r.json("run.run_id") === runId,
      },
      "universal submit verification failed",
    );
  },
};
