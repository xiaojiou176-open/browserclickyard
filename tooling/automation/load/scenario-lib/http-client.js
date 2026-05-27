import http from "k6/http";

function joinUrl(baseUrl, pathOrQuery) {
  if (pathOrQuery.startsWith("http://") || pathOrQuery.startsWith("https://")) {
    return pathOrQuery;
  }
  if (pathOrQuery.startsWith("/")) {
    return `${baseUrl}${pathOrQuery}`;
  }
  return `${baseUrl}/${pathOrQuery}`;
}

export function buildAutomationHeaders(config, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (config.credentials.automationToken) {
    headers["X-Automation-Token"] = config.credentials.automationToken;
  }
  if (config.credentials.automationClientId) {
    headers["X-Automation-Client-Id"] = config.credentials.automationClientId;
  }
  return headers;
}

export function getRequest(config, pathOrQuery, params = {}) {
  const headers = buildAutomationHeaders(config, params.headers || {});
  return http.get(joinUrl(config.baseUrl, pathOrQuery), {
    ...params,
    headers,
  });
}

export function postJson(config, pathOrQuery, payload, params = {}) {
  const headers = buildAutomationHeaders(config, {
    "Content-Type": "application/json",
    ...(params.headers || {}),
  });
  return http.post(joinUrl(config.baseUrl, pathOrQuery), JSON.stringify(payload), {
    ...params,
    headers,
  });
}
