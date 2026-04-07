import http from "k6/http";
import {
  assertBodyIncludes,
  assertChecks,
  parseJsonBody,
  requireNonEmptyString,
} from "../scenario-lib/assertions.js";
import { buildJourneyEmail, makeIterationSuffix } from "../scenario-lib/config.js";
import { getRequest, postJson } from "../scenario-lib/http-client.js";

export const publicRegisterScenario = {
  name: "public_register",
  description: "登录(注册) -> 搜索(重复账号检查) -> 关键操作(RUM) -> 提交确认(指标检索)",
  execute(context) {
    const suffix = makeIterationSuffix(context.vu, context.iter);
    const config = context.config;
    const dataset = config.dataset.public;
    const email = buildJourneyEmail(config, suffix);
    const password = config.credentials.password;

    const healthRes = getRequest(config, "/health/");
    assertChecks(
      healthRes,
      {
        "public/health status is 200": (r) => r.status === 200,
        "public/health status payload ok": (r) => r.json("status") === "ok",
      },
      "health check failed",
    );

    const csrfRes = getRequest(config, "/api/csrf");
    const csrfJson = parseJsonBody(csrfRes, "public login csrf");
    const csrfToken = requireNonEmptyString(csrfJson.csrf_token, "public login csrf token");
    assertChecks(
      csrfRes,
      {
        "public/login csrf status is 200": (r) => r.status === 200,
      },
      "login csrf bootstrap failed",
    );

    const registerRes = postJson(
      config,
      "/api/register",
      { email, password },
      {
        headers: {
          "X-CSRF-Token": csrfToken,
        },
      },
    );
    assertChecks(
      registerRes,
      {
        "public/login register status is 201": (r) => r.status === 201,
        "public/login register echoes email": (r) => r.json("email") === email,
      },
      "login register step failed",
    );

    const duplicateCsrfRes = getRequest(config, "/api/csrf");
    const duplicateCsrfJson = parseJsonBody(duplicateCsrfRes, "public search duplicate csrf");
    const duplicateCsrfToken = requireNonEmptyString(
      duplicateCsrfJson.csrf_token,
      "public duplicate csrf token",
    );
    assertChecks(
      duplicateCsrfRes,
      {
        "public/search duplicate csrf status is 200": (r) => r.status === 200,
      },
      "search duplicate csrf bootstrap failed",
    );

    const duplicateRes = postJson(
      config,
      "/api/register",
      { email, password },
      {
        headers: {
          "X-CSRF-Token": duplicateCsrfToken,
        },
        responseCallback: http.expectedStatuses(409),
      },
    );
    assertChecks(
      duplicateRes,
      {
        "public/search duplicate register status is 409": (r) => r.status === 409,
        "public/search duplicate detail matches": (r) =>
          r.json("detail") === String(dataset.duplicateDetail),
      },
      "search existing account check failed",
    );

    const rumMetric = String(dataset.rumMetric || "web_vitals_lcp")
      .trim()
      .toUpperCase();
    const rumRes = postJson(config, "/health/rum", {
      metric: String(dataset.rumMetric || "web_vitals_lcp"),
      value: Number(dataset.rumValue || 1200),
      path: String(dataset.rumPath || "/register"),
      timestampMs: Date.now(),
    });
    assertChecks(
      rumRes,
      {
        "public/critical rum submit status is 202": (r) => r.status === 202,
        "public/critical rum metric normalized": (r) => r.json("metric") === rumMetric,
        "public/critical rum samples_total positive": (r) => Number(r.json("samples_total")) >= 1,
      },
      "critical operation step failed",
    );

    const metricsRes = getRequest(config, "/health/metrics");
    assertChecks(
      metricsRes,
      {
        "public/submit metrics status is 200": (r) => r.status === 200,
      },
      "submit confirmation metrics fetch failed",
    );
    assertBodyIncludes(
      metricsRes.body,
      `uiq_rum_metric_latest{metric="${rumMetric}"}`,
      "submit confirmation metric lookup",
    );
  },
};
