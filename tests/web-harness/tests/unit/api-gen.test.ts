import { afterEach, describe, expect, it, vi } from "vitest";
import * as automationApi from "../../src/api-gen/api/automation";
import * as commandTowerApi from "../../src/api-gen/api/command-tower";
import * as healthApi from "../../src/api-gen/api/health";
import { API_OPERATIONS } from "../../src/api-gen/client";
import {
  ApiRequestError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  requestJson,
  setDefaultRequestTimeoutMs,
} from "../../src/api-gen/core/request";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const API_HANDLERS: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  ...(healthApi as Record<string, (...args: unknown[]) => Promise<unknown>>),
  ...(automationApi as Record<string, (...args: unknown[]) => Promise<unknown>>),
  ...(commandTowerApi as Record<string, (...args: unknown[]) => Promise<unknown>>),
};

const PATH_PARAM_VALUES: Record<string, string> = {
  task_id: "task/alpha beta",
  session_id: "session/with slash",
  action_id: "action:1",
  flow_id: "flow/v1",
  template_id: "template/中文",
  run_id: "run/id",
  campaign_id: "campaign/一期",
};

function buildPathParams(path: string): Record<string, string> {
  const matches = [...path.matchAll(/\{([^}]+)\}/g)];
  return Object.fromEntries(
    matches.map(([, name]) => [name, PATH_PARAM_VALUES[name] ?? `${name}-value`]),
  );
}

function buildExpectedPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name) =>
    encodeURIComponent(PATH_PARAM_VALUES[name] ?? `${name}-value`),
  );
}

function buildInit(method: string, operationId: string): RequestInit | undefined {
  if (method === "GET") {
    return undefined;
  }
  return {
    body: JSON.stringify({
      operation_id: operationId,
      sample: true,
    }),
  };
}

function createFetchMock(response: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body: string;
  contentType?: string;
}): ReturnType<typeof vi.fn> {
  const contentType = response.contentType ?? "application/json";
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? 200,
    statusText: response.statusText ?? "OK",
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null),
    },
    text: vi.fn().mockResolvedValue(response.body),
  });
}

describe("api-gen request helpers", () => {
  afterEach(() => {
    setDefaultRequestTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses json body and merges custom headers", async () => {
    const fetchMock = createFetchMock({ ok: true, body: JSON.stringify({ hello: "world" }) });
    vi.stubGlobal("fetch", fetchMock);

    const response = (await requestJson("https://api.example.com", "/hello", "POST", {
      headers: { authorization: "Bearer token" },
    })) as { hello: string };

    expect(response).toEqual({ hello: "world" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer token");
  });

  it("keeps auth headers from HeadersInit and auto-sets json content-type when body exists", async () => {
    const fetchMock = createFetchMock({ ok: true, body: JSON.stringify({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    const initHeaders = new Headers({ authorization: "Bearer from-headers-object" });
    await requestJson("https://api.example.com", "/with-body", "POST", {
      headers: initHeaders,
      body: JSON.stringify({ hello: "world" }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer from-headers-object");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("returns undefined for empty body", async () => {
    const emptyBodyFetch = createFetchMock({ ok: true, body: "" });
    vi.stubGlobal("fetch", emptyBodyFetch);
    await expect(requestJson("https://api.example.com", "/empty", "GET")).resolves.toBeUndefined();
  });

  it("preserves error body and throws a structured error for non-ok responses", async () => {
    const payload = {
      detail: "token is invalid",
      message: "unauthorized",
      error: "AUTH_FAILED",
    };
    const errorFetch = createFetchMock({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: JSON.stringify(payload),
    });
    vi.stubGlobal("fetch", errorFetch);

    await expect(requestJson("https://api.example.com", "/boom", "GET")).rejects.toThrow(
      "API request failed: 401 Unauthorized - token is invalid",
    );
    await expect(requestJson("https://api.example.com", "/boom", "GET")).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 401,
      statusText: "Unauthorized",
      body: expect.objectContaining({
        detail: payload.detail,
        message: payload.message,
        error: payload.error,
        rawText: JSON.stringify(payload),
      }),
    });
  });

  it("returns plain text when content-type is not json", async () => {
    const invalidJsonFetch = createFetchMock({
      ok: true,
      body: "<html>ok</html>",
      contentType: "text/html; charset=utf-8",
    });
    vi.stubGlobal("fetch", invalidJsonFetch);
    await expect(requestJson("https://api.example.com", "/invalid-json", "GET")).resolves.toBe(
      "<html>ok</html>",
    );
  });

  it("throws when content-type is json but body is invalid json", async () => {
    const invalidJsonFetch = createFetchMock({
      ok: true,
      body: "<not-json>",
      contentType: "application/json; charset=utf-8",
    });
    vi.stubGlobal("fetch", invalidJsonFetch);
    await expect(
      requestJson("https://api.example.com", "/invalid-json-body", "GET"),
    ).rejects.toThrow("API response is not valid JSON");
  });

  it("aborts by default timeout and supports default timeout override", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setDefaultRequestTimeoutMs(5);

    const requestPromise = requestJson("https://api.example.com", "/timeout", "GET");
    const assertion = expect(requestPromise).rejects.toThrow("Request timed out after 5ms");
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });

  it("merges external signal and timeout signal", async () => {
    const externalController = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = requestJson("https://api.example.com", "/abort", "GET", {
      timeoutMs: 1_000,
      signal: externalController.signal,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).not.toBe(externalController.signal);

    externalController.abort(new Error("manually aborted"));
    await expect(requestPromise).rejects.toThrow("manually aborted");
  });

  it("keeps raw text diagnostics for non-json non-ok responses", async () => {
    const errorFetch = createFetchMock({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      body: "upstream timeout",
      contentType: "text/plain",
    });
    vi.stubGlobal("fetch", errorFetch);

    await expect(requestJson("https://api.example.com", "/gateway", "GET")).rejects.toThrow(
      "API request failed: 502 Bad Gateway - upstream timeout",
    );
    try {
      await requestJson("https://api.example.com", "/gateway", "GET");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect((error as ApiRequestError).body.rawText).toBe("upstream timeout");
    }
  });
});

describe("api-gen endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes expected operation metadata in combined client export", () => {
    expect(API_OPERATIONS.length).toBe(
      healthApi.HEALTH_API_OPERATIONS.length +
        automationApi.AUTOMATION_API_OPERATIONS.length +
        commandTowerApi.COMMAND_TOWER_API_OPERATIONS.length,
    );
    expect(API_OPERATIONS).toContainEqual(expect.objectContaining({ operationId: "getHealth" }));
    expect(API_OPERATIONS).toContainEqual(
      expect.objectContaining({ operationId: "runAutomationCommand" }),
    );
    expect(API_OPERATIONS).toContainEqual(
      expect.objectContaining({ operationId: "getCommandTowerOverview" }),
    );
  });

  it("calls every generated endpoint with the expected path and HTTP method", async () => {
    const calls: Array<{ method: string; path: string; body?: JsonValue }> = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const method = String(init?.method ?? "GET");
      const parsedUrl = new URL(String(_url));
      let parsedBody: JsonValue | undefined;
      if (typeof init?.body === "string" && init.body.length > 0) {
        parsedBody = JSON.parse(init.body) as JsonValue;
      }
      calls.push({ method, path: parsedUrl.pathname, body: parsedBody });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const baseUrl = "https://api.example.com";

    for (const operation of API_OPERATIONS) {
      const handler = API_HANDLERS[operation.operationId];
      expect(handler, `missing handler for ${operation.operationId}`).toBeTypeOf("function");

      const pathParams = buildPathParams(operation.path);
      const init = buildInit(operation.method, operation.operationId);

      if (Object.keys(pathParams).length > 0 && init) {
        await handler(baseUrl, pathParams, init);
        continue;
      }
      if (Object.keys(pathParams).length > 0) {
        await handler(baseUrl, pathParams);
        continue;
      }
      if (init) {
        await handler(baseUrl, init);
        continue;
      }
      await handler(baseUrl);
    }

    expect(fetchMock).toHaveBeenCalledTimes(API_OPERATIONS.length);

    for (const operation of API_OPERATIONS) {
      const expectedPath = buildExpectedPath(operation.path);

      expect(calls).toContainEqual(
        expect.objectContaining({ method: operation.method, path: expectedPath }),
      );
    }
  });
});
