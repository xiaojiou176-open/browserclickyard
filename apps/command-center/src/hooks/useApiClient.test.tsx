/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceTimelineItem } from "../types";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../utils/api";
import { buildApiUrl, useApiClient } from "./useApiClient";
import type { AppStore } from "./useAppStore";

type StoreStub = {
  params: {
    baseUrl: string;
    automationToken: string;
    automationClientId: string;
  };
  studioOtpCode: string;
  selectedStepId: string;
  statusFilter: "all" | string;
  commandFilter: string;
  taskLimit: number;
  evidenceTimeline: Array<{ step_id: string }>;
  setCommands: ReturnType<typeof vi.fn>;
  setCommandState: ReturnType<typeof vi.fn>;
  setTasks: ReturnType<typeof vi.fn>;
  setTaskState: ReturnType<typeof vi.fn>;
  setTaskSyncError: ReturnType<typeof vi.fn>;
  setSelectedTaskId: ReturnType<typeof vi.fn>;
  setFlowError: ReturnType<typeof vi.fn>;
  setLatestFlow: ReturnType<typeof vi.fn>;
  setFlowDraft: ReturnType<typeof vi.fn>;
  setSelectedStepId: ReturnType<typeof vi.fn>;
  setStepEvidence: ReturnType<typeof vi.fn>;
  setStepEvidenceError: ReturnType<typeof vi.fn>;
  setEvidenceTimeline: ReturnType<typeof vi.fn>;
  setEvidenceTimelineError: ReturnType<typeof vi.fn>;
  setStudioFlows: ReturnType<typeof vi.fn>;
  setStudioTemplates: ReturnType<typeof vi.fn>;
  setStudioTemplateHistory: ReturnType<typeof vi.fn>;
  setStudioRuns: ReturnType<typeof vi.fn>;
  setSelectedStudioFlowId: ReturnType<typeof vi.fn>;
  setSelectedStudioTemplateId: ReturnType<typeof vi.fn>;
  setSelectedStudioRunId: ReturnType<typeof vi.fn>;
  setStudioError: ReturnType<typeof vi.fn>;
  pushNotice: ReturnType<typeof vi.fn>;
};

function createStore(baseUrl: string): AppStore & StoreStub {
  return {
    params: { baseUrl, automationToken: "", automationClientId: "client-001" },
    studioOtpCode: "",
    selectedStepId: "",
    statusFilter: "all",
    commandFilter: "",
    taskLimit: 50,
    evidenceTimeline: [],
    setCommands: vi.fn(),
    setCommandState: vi.fn(),
    setTasks: vi.fn(),
    setTaskState: vi.fn(),
    setTaskSyncError: vi.fn(),
    setSelectedTaskId: vi.fn((updater?: (prev: string) => string) =>
      typeof updater === "function" ? updater("") : updater,
    ),
    setFlowError: vi.fn(),
    setLatestFlow: vi.fn(),
    setFlowDraft: vi.fn(),
    setSelectedStepId: vi.fn((updater?: (prev: string) => string) =>
      typeof updater === "function" ? updater("") : updater,
    ),
    setStepEvidence: vi.fn(),
    setStepEvidenceError: vi.fn(),
    setEvidenceTimeline: vi.fn(),
    setEvidenceTimelineError: vi.fn(),
    setStudioFlows: vi.fn(),
    setStudioTemplates: vi.fn(),
    setStudioTemplateHistory: vi.fn(),
    setStudioRuns: vi.fn(),
    setSelectedStudioFlowId: vi.fn((updater?: (prev: string) => string) =>
      typeof updater === "function" ? updater("") : updater,
    ),
    setSelectedStudioTemplateId: vi.fn((updater?: (prev: string) => string) =>
      typeof updater === "function" ? updater("") : updater,
    ),
    setSelectedStudioRunId: vi.fn((updater?: (prev: string) => string) =>
      typeof updater === "function" ? updater("") : updater,
    ),
    setStudioError: vi.fn(),
    pushNotice: vi.fn(),
  } as unknown as AppStore & StoreStub;
}

function createTimelineItem(stepId: string): EvidenceTimelineItem {
  return {
    step_id: stepId,
    action: null,
    ok: null,
    detail: null,
    duration_ms: null,
    matched_selector: null,
    selector_index: null,
    screenshot_before_path: null,
    screenshot_after_path: null,
    screenshot_before_data_url: null,
    screenshot_after_data_url: null,
    fallback_trail: [],
  };
}

function createSuccessResponse() {
  return createJsonResponse({ commands: [] });
}

function createErrorResponse(status = 400, detail = "invalid request") {
  return createJsonResponse(
    { detail },
    {
      status,
      statusText: "Bad Request",
      headers: { "x-request-id": "req_test_error" },
    },
  );
}

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function createTextResponse(text: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/plain; charset=utf-8");
  }
  return new Response(text, { ...init, headers });
}

function createEmptyResponse(status = 204, init?: Omit<ResponseInit, "status">): Response {
  return new Response(null, { ...init, status });
}

function createDeferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useApiClient baseUrl routing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useApiClient> | null;
  let previousApiBaseUrl: unknown;

  beforeEach(() => {
    const env = import.meta.env as Record<string, unknown>;
    previousApiBaseUrl = env.VITE_API_BASE_URL;
    delete env.VITE_API_BASE_URL;
    api = null;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    const env = import.meta.env as Record<string, unknown>;
    if (previousApiBaseUrl === undefined) {
      delete env.VITE_API_BASE_URL;
    } else {
      env.VITE_API_BASE_URL = previousApiBaseUrl;
    }
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("builds absolute API URL when baseUrl is absolute", () => {
    expect(buildApiUrl("http://127.0.0.1:8000", "/api/automation/commands")).toBe(
      "http://127.0.0.1:8000/api/automation/commands",
    );
  });

  it("supports root-relative base path for API proxy prefix", () => {
    expect(buildApiUrl("/gateway", "/api/automation/commands")).toBe(
      "/gateway/api/automation/commands",
    );
  });

  it("falls back to relative API path when baseUrl is not absolute", () => {
    expect(buildApiUrl("backend.local", "/api/automation/commands")).toBe(
      "/api/automation/commands",
    );
  });

  it("uses resolved baseUrl when fetching commands", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn().mockResolvedValue(createSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.fetchCommands();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/gateway/api/automation/commands",
      expect.objectContaining({ headers: {} }),
    );
    expect(store.setCommands).toHaveBeenCalledWith([]);
    expect(store.setCommandState).toHaveBeenCalledWith("empty");
  });

  it("keeps API base stable when command target baseUrl changes after mount", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn().mockResolvedValue(createSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    store.params.baseUrl = "https://target.example.com";

    await act(async () => {
      await api?.fetchCommands();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/gateway/api/automation/commands",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("includes token and client id headers when automationToken exists", async () => {
    const store = createStore("/gateway");
    store.params.automationToken = "token-123";
    store.params.automationClientId = "client-xyz";
    const fetchMock = vi.fn().mockResolvedValue(createSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.fetchCommands();
    });

    expect(fetchMock).toHaveBeenCalledWith("/gateway/api/automation/commands", {
      headers: {
        "x-automation-token": "token-123",
        "x-automation-client-id": "client-xyz",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("does not fallback to VITE_AUTOMATION_TOKEN when user token is empty", async () => {
    const env = import.meta.env as Record<string, unknown>;
    const previousEnvToken = env.VITE_AUTOMATION_TOKEN;
    env.VITE_AUTOMATION_TOKEN = "env-default-token";
    const store = createStore("/gateway");
    store.params.automationToken = "   ";
    store.params.automationClientId = "client-xyz";
    const fetchMock = vi.fn().mockResolvedValue(createSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    try {
      await act(async () => {
        await api?.fetchCommands();
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/gateway/api/automation/commands",
        expect.objectContaining({ headers: {} }),
      );
    } finally {
      env.VITE_AUTOMATION_TOKEN = previousEnvToken;
    }
  });

  it("does not force JSON parsing for 2xx text payloads", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn().mockResolvedValue(createTextResponse("plain-ok"));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.fetchLatestFlow();
    });

    expect(store.setFlowError).toHaveBeenCalledWith("");
    expect(store.setLatestFlow).toHaveBeenCalledWith(null);
  });

  it("handles 204 empty success payload without JSON parsing", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn().mockResolvedValue(createEmptyResponse(204));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.fetchLatestFlowDraft();
    });

    expect(store.setFlowError).toHaveBeenCalledWith("");
    expect(store.setFlowDraft).toHaveBeenCalledWith(null);
  });

  it("preserves timeout abort reason from merged signal", async () => {
    vi.useFakeTimers();
    const store = createStore("/gateway");
    const fetchMock = vi.fn((_input: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_, reject) => {
        if (!signal) {
          return;
        }
        const rejectWithReason = () => {
          const reason = signal.reason;
          if (reason instanceof Error) {
            reject(reason);
            return;
          }
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal.aborted) {
          rejectWithReason();
          return;
        }
        signal.addEventListener("abort", rejectWithReason, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const request = api?.fetchCommands();
    const assertion = expect(request).rejects.toThrow(
      `Request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
    );
    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS + 1);
      await Promise.resolve();
    });
    await assertion;
  });

  it("uses response text as error detail for non-json error body", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn().mockResolvedValue(
      createTextResponse("gateway down", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "x-request-id": "req_plain_text" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await expect(api?.fetchCommands()).rejects.toThrow(
      "Loading the command list failed\uff1aHTTP 502 - gateway down\uff0crequest_id=req_plain_text",
    );
  });

  it("never sends raw model api keys in run params", async () => {
    const store = {
      params: {
        baseUrl: "/gateway",
        startUrl: "",
        successSelector: "#ok",
        modelName: "gemini-3.1-pro-preview",
        geminiApiKey: "gemini-key-123",
        registerPassword: "",
        automationToken: "",
        automationClientId: "client-001",
        headless: false,
        midsceneStrict: false,
      },
      setSubmittingId: vi.fn(),
      setActionState: vi.fn(),
      addLog: vi.fn(),
      setFeedbackText: vi.fn(),
      pushNotice: vi.fn(),
    } as unknown as AppStore;
    const fetchMock = vi.fn().mockResolvedValue(createErrorResponse(400, "invalid request"));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.runCommand({ command_id: "cmd-gemini", title: "Run with Gemini" } as never);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body)) as {
      command?: string;
      command_id?: string;
      params: Record<string, string>;
    };
    expect(requestBody.command).toBe("cmd-gemini");
    expect(requestBody).not.toHaveProperty("command_id");
    expect(requestBody.params).not.toHaveProperty("GEMINI_API_KEY");
    expect(requestBody.params).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("does not request evidence when step is missing in evidenceTimeline", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.fetchStepEvidence("s-not-in-timeline");
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.setStepEvidence).toHaveBeenCalledWith(null);
    expect(store.setStepEvidenceError).toHaveBeenCalledWith("");
  });

  it("submits empty otp_code when waiting_user is provider protected", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "   ";
    const fetchMock = vi.fn().mockResolvedValue(createErrorResponse(400, "still waiting"));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run-provider-protected", "waiting_user", {
        reason_code: "provider_protected_payment_step",
      });
    });

    expect(fetchMock).toHaveBeenCalledWith("/gateway/api/runs/run-provider-protected/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "approval", approved: true }),
      signal: expect.any(AbortSignal),
    });
  });

  it("submits approval when waiting_user only allows approval", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "   ";
    const fetchMock = vi.fn().mockResolvedValue(createErrorResponse(400, "still waiting"));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run-approval-only", "waiting_user", {
        reason_code: "manual_confirmation_required",
        allowed_resume_kinds: ["approval"],
        required_actions: [{ kind: "approval", label: "Approve and continue" }],
      });
    });

    expect(fetchMock).toHaveBeenCalledWith("/gateway/api/runs/run-approval-only/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "approval", approved: true }),
      signal: expect.any(AbortSignal),
    });
  });

  it("encodes run id in submitRunOtp path", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "123456";
    const fetchMock = vi.fn().mockResolvedValue(createErrorResponse(400, "otp invalid"));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run/id localized", "waiting_otp");
    });

    expect(fetchMock).toHaveBeenCalledWith("/gateway/api/runs/run%2Fid%20localized/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "otp", otp_code: "123456" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps non-provider waiting_user empty input blocked before request", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "   ";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run-waiting-user", "waiting_user", {
        reason_code: "manual_input_required",
      });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.setStudioError).toHaveBeenCalled();
  });

  it("keeps waiting_otp empty input blocked before request", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "   ";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run-waiting-otp", "waiting_otp");
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.setStudioError).toHaveBeenCalled();
  });

  it("sets actionable evidence timeline error when fetch fails", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn().mockResolvedValue(createErrorResponse(503, "service unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.fetchEvidenceTimeline();
    });

    expect(store.setEvidenceTimeline).toHaveBeenCalledWith([]);
    expect(store.setEvidenceTimelineError).toHaveBeenCalledTimes(1);
    const [message] = store.setEvidenceTimelineError.mock.calls[0] as [string];
    expect(message).toContain("Issue:");
    expect(message).toContain("Recommended action:");
    expect(message).toContain("Troubleshooting entry:");
    expect(message).toContain("\n");
  });

  it("ignores stale step evidence responses and keeps latest selection evidence", async () => {
    const store = createStore("/gateway");
    store.evidenceTimeline = [createTimelineItem("step-a"), createTimelineItem("step-b")];
    const stepADeferred = createDeferredResponse();
    const fetchMock = vi.fn((input: string) => {
      if (input.includes("step_id=step-a")) {
        return stepADeferred.promise;
      }
      if (input.includes("step_id=step-b")) {
        return Promise.resolve(createJsonResponse({ step_id: "step-b" }));
      }
      return Promise.resolve(createSuccessResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const stepAPromise = api?.fetchStepEvidence("step-a");
    await act(async () => {
      await api?.fetchStepEvidence("step-b");
    });
    await act(async () => {
      stepADeferred.resolve(createJsonResponse({ step_id: "step-a" }));
      await stepAPromise;
    });

    const evidencePayloads = store.setStepEvidence.mock.calls.map(([payload]) => payload) as Array<{
      step_id?: string;
    }>;
    const evidenceStepIds = evidencePayloads
      .map((payload) => payload?.step_id)
      .filter((stepId): stepId is string => Boolean(stepId));
    expect(evidenceStepIds).toContain("step-b");
    expect(evidenceStepIds).not.toContain("step-a");
  });

  it("refreshTasks refreshes tasks and studio runs together", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi.fn((input: string) => {
      if (input.includes("/api/automation/tasks?")) {
        return Promise.resolve(createJsonResponse({ tasks: [] }));
      }
      if (input === "/gateway/api/flows?limit=100") {
        return Promise.resolve(createJsonResponse({ flows: [] }));
      }
      if (input === "/gateway/api/templates?limit=100") {
        return Promise.resolve(createJsonResponse({ templates: [] }));
      }
      if (input === "/gateway/api/runs?limit=100") {
        return Promise.resolve(createJsonResponse({ runs: [] }));
      }
      return Promise.resolve(createSuccessResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      api?.refreshTasks();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/gateway/api/runs?limit=100",
      expect.objectContaining({ headers: {} }),
    );
    expect(store.setStudioRuns).toHaveBeenCalledWith([]);
    expect(store.setTasks).toHaveBeenCalledWith([]);
  });

  it("handles 204 empty response body without JSON parse error", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "123456";
    const fetchMock = vi.fn((input: string) => {
      if (input === "/gateway/api/runs/run-204/resume") {
        return Promise.resolve(createEmptyResponse(204));
      }
      if (input === "/gateway/api/flows?limit=100") {
        return Promise.resolve(createJsonResponse({ flows: [] }));
      }
      if (input === "/gateway/api/templates?limit=100") {
        return Promise.resolve(createJsonResponse({ templates: [] }));
      }
      if (input === "/gateway/api/runs?limit=100") {
        return Promise.resolve(createJsonResponse({ runs: [] }));
      }
      if (input.includes("/api/automation/tasks?")) {
        return Promise.resolve(createJsonResponse({ tasks: [] }));
      }
      return Promise.resolve(createSuccessResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run-204", "waiting_otp");
    });

    expect(store.setStudioError).toHaveBeenLastCalledWith("");
    expect(store.pushNotice).toHaveBeenCalledWith("success", "OTP submitted, run resumed");
  });

  it("treats successful non-JSON text response as valid payload", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "123456";
    const fetchMock = vi.fn((input: string) => {
      if (input === "/gateway/api/runs/run-text/resume") {
        return Promise.resolve(createTextResponse("accepted"));
      }
      if (input === "/gateway/api/flows?limit=100") {
        return Promise.resolve(createJsonResponse({ flows: [] }));
      }
      if (input === "/gateway/api/templates?limit=100") {
        return Promise.resolve(createJsonResponse({ templates: [] }));
      }
      if (input === "/gateway/api/runs?limit=100") {
        return Promise.resolve(createJsonResponse({ runs: [] }));
      }
      if (input.includes("/api/automation/tasks?")) {
        return Promise.resolve(createJsonResponse({ tasks: [] }));
      }
      return Promise.resolve(createSuccessResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run-text", "waiting_otp");
    });

    expect(store.setStudioError).toHaveBeenLastCalledWith("");
    expect(store.pushNotice).toHaveBeenCalledWith("success", "OTP submitted, run resumed");
  });

  it("reports invalid JSON when content-type is JSON but payload is malformed", async () => {
    const store = createStore("/gateway");
    store.studioOtpCode = "123456";
    const fetchMock = vi.fn((input: string) => {
      if (input === "/gateway/api/runs/run-bad-json/resume") {
        return Promise.resolve(
          createTextResponse("{invalid", {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(createSuccessResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      await api?.submitRunOtp("run-bad-json", "waiting_otp");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.setStudioError).toHaveBeenCalledTimes(1);
    const [message] = store.setStudioError.mock.calls[0] as [string];
    expect(message).toContain("API response is not valid JSON");
  });

  it("surfaces timeout errors consistently with generated client message", async () => {
    vi.useFakeTimers();
    const store = createStore("/gateway");
    const fetchMock = vi.fn((_input: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const pending = api!.fetchCommands();
    const timeoutAssertion = expect(pending).rejects.toThrow(
      `Request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    await timeoutAssertion;
  });

  it("keeps abort error semantics without forcing JSON parsing", async () => {
    const store = createStore("/gateway");
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("This operation was aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      api = useApiClient(store);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    await expect(api!.fetchCommands()).rejects.toThrow("This operation was aborted");
  });
});
