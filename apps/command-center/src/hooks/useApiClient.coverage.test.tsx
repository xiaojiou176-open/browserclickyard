/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApiUrl, useApiClient } from "./useApiClient";
import type { AppStore } from "./useAppStore";

function createRichStore() {
  const store = {
    params: {
      baseUrl: "/gateway",
      startUrl: "https://example.com/start",
      successSelector: "#ok",
      modelName: "models/gemini-3.1-pro-preview",
      geminiApiKey: "",
      registerPassword: "pw-123",
      automationToken: "",
      automationClientId: "",
      headless: false,
      midsceneStrict: false,
    },
    studioOtpCode: "123456",
    statusFilter: "running",
    commandFilter: "cmd-1",
    taskLimit: 20,
    evidenceTimeline: [{ step_id: "step-1" }],
    reconstructionArtifacts: { screenshot: "s1" },
    reconstructionMode: "gemini",
    reconstructionStrategy: "balanced",
    reconstructionPreview: { preview_id: "preview-1" },
    studioTemplateName: "tmpl-1",
    flowDraft: {
      flow_id: "flow-1",
      session_id: "sess-1",
      start_url: "https://example.com",
      steps: [{ step_id: "step-1", action: "click" }],
    },
    selectedStepId: "step-1",
    resumeWithPreconditions: true,
    selectedStudioFlowId: "flow-1",
    selectedStudioTemplateId: "template-1",
    studioRunParams: { email: "demo@example.com" },
    studioSchemaRows: [
      {
        key: "status",
        type: "enum",
        required: true,
        description: "Status",
        enum_values: "open, closed",
        pattern: "",
      },
      {
        key: "token",
        type: "regex",
        required: false,
        description: "  ",
        enum_values: "",
        pattern: "\\w+",
      },
      { key: " ", type: "string", required: false, description: "", enum_values: "", pattern: "" },
    ],
    studioDefaults: { status: "open" },
    studioPolicies: {
      retries: 1,
      timeout_seconds: 30,
      otp: {
        required: false,
        provider: "manual",
        timeout_seconds: 60,
        regex: "\\d{6}",
        sender_filter: "",
        subject_filter: "",
      },
    },

    setCommands: vi.fn(),
    setCommandState: vi.fn(),
    setTasks: vi.fn(),
    setTaskState: vi.fn(),
    setTaskSyncError: vi.fn(),
    setSelectedTaskId: vi.fn((updater?: (prev: string) => string) =>
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
    setDiagnosticsError: vi.fn(),
    setDiagnostics: vi.fn(),
    setAlertError: vi.fn(),
    setAlerts: vi.fn(),
    setFlowError: vi.fn(),
    setLatestFlow: vi.fn(),
    setFlowDraft: vi.fn(),
    setProfileResolved: vi.fn(),
    setReconstructionError: vi.fn(),
    setReconstructionPreview: vi.fn(),
    setReconstructionGenerated: vi.fn(),
    setSubmittingId: vi.fn(),
    setActionState: vi.fn(),
    setFeedbackText: vi.fn(),
    addLog: vi.fn(),
    pushNotice: vi.fn(),
    setParams: vi.fn((updater: (p: typeof store.params) => typeof store.params) => {
      if (typeof updater === "function") {
        store.params = updater(store.params);
      }
    }),
    setSelectedStepId: vi.fn((value: string) => {
      store.selectedStepId = value;
    }),
  };
  return store as unknown as AppStore & Record<string, ReturnType<typeof vi.fn>>;
}

function createResponse(payload: unknown, ok = true, status = 200) {
  const bodyText =
    payload === null || payload === undefined
      ? ""
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload);
  const headers = new Headers();
  headers.set(
    "content-type",
    typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
  );
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers,
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(bodyText),
  } as unknown as Response;
}

describe("useApiClient coverage expansion", () => {
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
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("covers end-to-end happy paths across api methods", async () => {
    const store = createRichStore();
    const fetchMock = vi.fn((input: string) => {
      if (input.includes("/api/automation/commands")) {
        return Promise.resolve(createResponse({ commands: [{ command_id: "cmd-1" }] }));
      }
      if (input.includes("/api/automation/tasks?")) {
        return Promise.resolve(
          createResponse({
            tasks: [{ task_id: "task-1", status: "running", command_id: "cmd-1" }],
          }),
        );
      }
      if (input.endsWith("/health/diagnostics")) {
        return Promise.resolve(createResponse({ ok: true }));
      }
      if (input.endsWith("/health/alerts")) {
        return Promise.resolve(createResponse({ alerts: [] }));
      }
      if (input.endsWith("/api/command-tower/latest-flow")) {
        return Promise.resolve(createResponse({ flow_id: "flow-1" }));
      }
      if (input.endsWith("/api/command-tower/latest-flow-draft")) {
        return Promise.resolve(
          createResponse({
            flow: {
              flow_id: "flow-1",
              session_id: "session-1",
              start_url: "https://example.com",
              steps: [{ step_id: "step-1", action: "click" }],
            },
          }),
        );
      }
      if (input.includes("/api/command-tower/evidence?")) {
        return Promise.resolve(createResponse({ step_id: "step-1", screenshot: "ok" }));
      }
      if (input.endsWith("/api/command-tower/evidence-timeline")) {
        return Promise.resolve(createResponse({ items: [{ step_id: "step-1" }] }));
      }
      if (input.endsWith("/api/flows?limit=100")) {
        return Promise.resolve(createResponse({ flows: [{ flow_id: "flow-1" }] }));
      }
      if (input.endsWith("/api/templates?limit=100")) {
        return Promise.resolve(createResponse({ templates: [{ template_id: "template-1" }] }));
      }
      if (input.endsWith("/api/runs?limit=100")) {
        return Promise.resolve(createResponse({ runs: [{ run_id: "run-1" }] }));
      }
      if (input.endsWith("/api/profiles/resolve")) {
        return Promise.resolve(createResponse({ profile_id: "profile-1" }));
      }
      if (input.endsWith("/api/reconstruction/preview")) {
        return Promise.resolve(createResponse({ preview_id: "preview-2" }));
      }
      if (input.endsWith("/api/reconstruction/generate")) {
        return Promise.resolve(createResponse({ template_id: "template-new" }));
      }
      if (input.endsWith("/api/command-tower/orchestrate-from-artifacts")) {
        return Promise.resolve(createResponse({ ok: true }));
      }
      if (input.endsWith("/api/automation/run")) {
        return Promise.resolve(
          createResponse({ task: { task_id: "task-run-1", command_id: "cmd-1" } }),
        );
      }
      if (input.includes("/api/automation/tasks/") && input.endsWith("/cancel")) {
        return Promise.resolve(createResponse({ ok: true }));
      }
      if (input.endsWith("/api/command-tower/replay-latest")) {
        return Promise.resolve(
          createResponse({ task: { task_id: "task-replay", command_id: "cmd-1" } }),
        );
      }
      if (input.endsWith("/api/command-tower/replay-latest-step")) {
        return Promise.resolve(
          createResponse({ task: { task_id: "task-step", command_id: "cmd-1" } }),
        );
      }
      if (input.endsWith("/api/command-tower/replay-latest-from-step")) {
        return Promise.resolve(
          createResponse({ task: { task_id: "task-from-step", command_id: "cmd-1" } }),
        );
      }
      if (input.endsWith("/api/flows/import-latest")) {
        return Promise.resolve(createResponse({ ok: true }));
      }
      if (input.endsWith("/api/templates")) {
        return Promise.resolve(createResponse({ template_id: "template-2" }));
      }
      if (input.includes("/api/templates/") && !input.endsWith("/api/templates?limit=100")) {
        return Promise.resolve(createResponse({ template_id: "template-1" }));
      }
      if (input.endsWith("/api/runs")) {
        return Promise.resolve(createResponse({ run: { run_id: "run-created" } }));
      }
      if (input.includes("/api/runs/") && input.endsWith("/resume")) {
        return Promise.resolve(createResponse({ run_id: "run-after-otp" }));
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      await api?.fetchCommands();
      await api?.fetchTasks();
      await api?.fetchDiagnostics();
      await api?.fetchAlerts();
      await api?.fetchLatestFlow();
      await api?.fetchLatestFlowDraft();
      await api?.fetchStepEvidence("step-1");
      await api?.fetchEvidenceTimeline();
      await api?.fetchStudioData();
      await api?.resolveProfile();
      await api?.previewReconstruction();
      await api?.generateReconstruction();
      await api?.orchestrateFromArtifacts();
      await api?.runCommand({ command_id: "cmd-1", title: "Command 1" } as never);
      await api?.cancelTask({ task_id: "task-cancel", command_id: "cmd-1" } as never);
      await api?.saveFlowDraft();
      await api?.replayLatestFlow();
      await api?.replayStep("step-1");
      await api?.replayFromStep("step-1");
      await api?.importLatestFlow();
      await api?.createTemplate();
      await api?.updateTemplate();
      await api?.createRun();
      await api?.submitRunOtp("run-created", "waiting_otp");
      api?.refreshDiagnostics();
      api?.refreshStudio();
      api?.refreshTasks();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.setReconstructionGenerated).toHaveBeenCalledWith({ template_id: "template-new" });
    expect(store.setSelectedTaskId).toHaveBeenCalledWith("task-run-1");
    expect(store.pushNotice).toHaveBeenCalledWith("success", "Template updated successfully");
    expect(store.setSelectedStudioRunId).toHaveBeenCalledWith("run-after-otp");
    expect(fetchMock).toHaveBeenCalledWith(
      "/gateway/api/reconstruction/generate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("covers major failure and guard branches", async () => {
    const store = createRichStore();
    store.studioOtpCode = "   ";
    store.reconstructionPreview = null;

    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith("/health/diagnostics")) {
        return Promise.resolve(createResponse({ detail: "boom" }, false, 503));
      }
      if (input.endsWith("/health/alerts")) {
        return Promise.resolve(createResponse({ detail: "boom" }, false, 500));
      }
      if (input.endsWith("/api/command-tower/latest-flow-draft")) {
        return Promise.resolve(createResponse({ flow: {} }));
      }
      if (input.includes("/api/command-tower/evidence?")) {
        return Promise.resolve(createResponse({ detail: "not found" }, false, 404));
      }
      if (input.endsWith("/api/flows?limit=100")) {
        return Promise.resolve(createResponse({ detail: "bad" }, false, 500));
      }
      if (input.includes("/api/automation/tasks/") && input.endsWith("/cancel")) {
        return Promise.reject(new Error("fetch failed"));
      }
      if (input.endsWith("/api/automation/commands")) {
        return Promise.reject(new Error("Failed to fetch"));
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      await api?.fetchDiagnostics();
      await api?.fetchAlerts();
      await api?.fetchLatestFlowDraft();
      await api?.fetchStepEvidence("step-1");
      await api?.fetchStudioData().catch(() => undefined);
      await api?.generateReconstruction();
      await api?.createRun();
      await api?.submitRunOtp("run-1", "waiting_user", { reason_code: "manual_input_required" });
      await api?.cancelTask({ task_id: "task-1", command_id: "cmd-1" } as never);
      await api?.fetchCommands().catch(() => undefined);
    });

    expect(store.setDiagnostics).toHaveBeenCalledWith(null);
    expect(store.setAlerts).toHaveBeenCalledWith(null);
    expect(store.setFlowDraft).toHaveBeenCalledWith(null);
    expect(store.setStepEvidence).toHaveBeenCalledWith(null);
    expect(store.setReconstructionError).toHaveBeenCalled();
    expect(store.setStudioError).toHaveBeenCalled();
    expect(store.pushNotice).toHaveBeenCalledWith("error", expect.stringContaining("Issue:"));
  });

  it("covers remaining guard and error branches for critical paths", async () => {
    const store = createRichStore();
    store.setSelectedStepId = vi.fn((next: string | ((prev: string) => string)) =>
      typeof next === "function" ? next("step-1") : next,
    );
    store.selectedStudioFlowId = "";
    store.selectedStudioTemplateId = "";

    let draftCall = 0;
    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith("/health/diagnostics")) {
        return Promise.reject(new Error("diag transport down"));
      }
      if (input.endsWith("/health/alerts")) {
        return Promise.reject(new Error("alert transport down"));
      }
      if (input.endsWith("/api/command-tower/latest-flow")) {
        return Promise.resolve(createResponse({ detail: "flow failed" }, false, 500));
      }
      if (input.endsWith("/api/command-tower/latest-flow-draft")) {
        draftCall += 1;
        if (draftCall === 1) {
          return Promise.resolve(createResponse({ detail: "draft failed" }, false, 500));
        }
        if (draftCall === 2) {
          return Promise.resolve(createResponse({ flow: 1 }));
        }
        return Promise.resolve(
          createResponse({
            flow: {
              flow_id: "flow-x",
              session_id: "session-x",
              start_url: "https://example.com",
              steps: [{ step_id: "step-1", action: "click" }],
            },
          }),
        );
      }
      if (input.includes("/api/command-tower/evidence?")) {
        return Promise.resolve(createResponse({ detail: "server err" }, false, 500));
      }
      if (input.endsWith("/api/profiles/resolve")) {
        return Promise.reject(new Error("Issue: Profile error\nRecommended action: Retry\nTroubleshooting entry: Check logs"));
      }
      if (input.endsWith("/api/reconstruction/preview")) {
        return Promise.reject(new Error("preview failed"));
      }
      if (input.endsWith("/api/command-tower/orchestrate-from-artifacts")) {
        return Promise.reject(new Error("orchestrate failed"));
      }
      if (input.endsWith("/api/command-tower/replay-latest-step")) {
        return Promise.reject(new Error("step failed"));
      }
      if (input.endsWith("/api/command-tower/replay-latest-from-step")) {
        return Promise.reject(new Error("from step failed"));
      }
      if (input.endsWith("/api/flows/import-latest")) {
        return Promise.reject(new Error("import failed"));
      }
      if (input.endsWith("/api/flows?limit=100")) {
        return Promise.resolve(createResponse({ detail: "studio failed" }, false, 500));
      }
      if (input.includes("/api/automation/tasks?")) {
        return Promise.resolve(createResponse({ tasks: [] }));
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      await api?.fetchDiagnostics();
      await api?.fetchAlerts();
      await api?.fetchLatestFlow();
      await api?.fetchLatestFlowDraft();
      await api?.fetchLatestFlowDraft();
      await api?.fetchLatestFlowDraft();
      await api?.fetchStepEvidence("   ");
      await api?.fetchStepEvidence("step-1");
      await api?.resolveProfile();
      await api?.previewReconstruction();
      await api?.orchestrateFromArtifacts();
      await api?.replayStep("step-1");
      await api?.replayFromStep("step-1");
      await api?.importLatestFlow();
      await api?.createTemplate();
      await api?.updateTemplate();
      api?.refreshStudio();
      api?.refreshTasks();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.setDiagnosticsError).toHaveBeenCalled();
    expect(store.setAlertError).toHaveBeenCalled();
    expect(store.setFlowError).toHaveBeenCalled();
    expect(store.setStepEvidenceError).toHaveBeenCalled();
    expect(store.setProfileResolved).not.toHaveBeenCalled();
    expect(store.setReconstructionPreview).not.toHaveBeenCalled();
    expect(store.pushNotice).toHaveBeenCalledWith("error", expect.any(String));
    expect(store.setStudioError).toHaveBeenCalled();
    expect(store.setFlowDraft).toHaveBeenCalledWith(null);
  });

  it("treats missing Universal Studio bootstrap endpoints as an empty state instead of a blocking error", async () => {
    const store = createRichStore();

    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith("/api/flows?limit=100")) {
        return Promise.resolve(createResponse({ detail: "not found" }, false, 404));
      }
      if (input.endsWith("/api/templates?limit=100")) {
        return Promise.resolve(createResponse({ detail: "not found" }, false, 404));
      }
      if (input.endsWith("/api/runs?limit=100")) {
        return Promise.resolve(createResponse({ detail: "not found" }, false, 404));
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      await api?.fetchStudioData();
    });

    expect(store.setStudioError).toHaveBeenLastCalledWith("");
    expect(store.setStudioFlows).toHaveBeenLastCalledWith([]);
    expect(store.setStudioTemplates).toHaveBeenLastCalledWith([]);
    expect(store.setStudioRuns).toHaveBeenLastCalledWith([]);
  });

  it("covers buildApiUrl branch matrix", () => {
    expect(buildApiUrl(" https://api.example.com ", "   ")).toBe("   ");
    expect(buildApiUrl("https://api.example.com", "https://other.example.com/x")).toBe(
      "https://other.example.com/x",
    );
    expect(buildApiUrl("   ", "tasks")).toBe("/tasks");
    expect(buildApiUrl("/", "/status")).toBe("/status");
    expect(buildApiUrl("/gateway///", "tasks")).toBe("/gateway/tasks");
    expect(buildApiUrl("ftp://example.com", "tasks")).toBe("/tasks");
    expect(buildApiUrl("::not-url::", "tasks")).toBe("/tasks");
  });

  it("covers non-Error catch branches and guard branches for template/run actions", async () => {
    const store = createRichStore();
    store.flowDraft = null;

    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith("/api/automation/run")) {
        return Promise.reject("run command string failure");
      }
      if (input.includes("/api/automation/tasks/") && input.endsWith("/cancel")) {
        return Promise.reject("cancel string failure");
      }
      if (input.endsWith("/api/command-tower/orchestrate-from-artifacts")) {
        return Promise.reject("orchestrate string failure");
      }
      if (input.endsWith("/api/command-tower/replay-latest")) {
        return Promise.reject("replay latest string failure");
      }
      if (input.endsWith("/api/command-tower/replay-latest-step")) {
        return Promise.reject("replay step string failure");
      }
      if (input.endsWith("/api/command-tower/replay-latest-from-step")) {
        return Promise.reject("replay from step string failure");
      }
      if (input.endsWith("/api/templates")) {
        return Promise.reject("create template string failure");
      }
      if (input.includes("/api/templates/")) {
        return Promise.reject("update template string failure");
      }
      if (input.endsWith("/api/runs")) {
        return Promise.reject("create run string failure");
      }
      if (input.includes("/api/runs/") && input.endsWith("/resume")) {
        return Promise.reject("submit otp string failure");
      }
      if (input.endsWith("/api/flows?limit=100")) {
        return Promise.reject("studio refresh string failure");
      }
      if (input.includes("/api/automation/tasks?")) {
        return Promise.resolve(createResponse({ tasks: [] }));
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      await api?.runCommand({ command_id: "cmd-x", title: "Command X" } as never);
      await api?.cancelTask({ task_id: "task-x", command_id: "cmd-x" } as never);
      await api?.saveFlowDraft();
      await api?.orchestrateFromArtifacts();
      await api?.replayLatestFlow();
      await api?.replayStep("step-1");
      await api?.replayFromStep("step-1");

      store.selectedStudioFlowId = "";
      store.flowDraft = null;
      await api?.createTemplate();

      store.selectedStudioFlowId = "flow-1";
      await api?.createTemplate();

      store.selectedStudioTemplateId = "";
      await api?.updateTemplate();

      store.selectedStudioTemplateId = "template-1";
      await api?.updateTemplate();

      await api?.createRun();
      store.selectedStudioTemplateId = "template-1";
      await api?.createRun();

      await api?.submitRunOtp("run-x", "waiting_otp");
      api?.refreshStudio();
      api?.refreshTasks();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.setSubmittingId).toHaveBeenCalledWith("");
    expect(store.setFeedbackText).toHaveBeenCalled();
    expect(store.setStudioError).toHaveBeenCalled();
    expect(store.pushNotice).toHaveBeenCalledWith("error", expect.any(String));
  });

  it("covers template version fork and recommended template actions", async () => {
    const store = createRichStore();
    let failFork = false;
    let failRecommended = false;

    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith("/api/flows?limit=100")) {
        return Promise.resolve(createResponse({ flows: [] }));
      }
      if (input.endsWith("/api/templates?limit=100")) {
        return Promise.resolve(createResponse({ templates: [] }));
      }
      if (input.endsWith("/api/runs?limit=100")) {
        return Promise.resolve(createResponse({ runs: [] }));
      }
      if (input.includes("/fork-version")) {
        if (failFork) {
          return Promise.reject(new Error("fork failed"));
        }
        return Promise.resolve(createResponse({ ok: true }));
      }
      if (input.includes("/mark-recommended")) {
        if (failRecommended) {
          return Promise.reject("mark recommended string failure");
        }
        return Promise.resolve(createResponse({ ok: true }));
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      await api?.forkTemplateVersion();
      await api?.markTemplateRecommended();

      store.selectedStudioTemplateId = "";
      await api?.forkTemplateVersion();
      await api?.markTemplateRecommended();

      store.selectedStudioTemplateId = "template-1";
      failFork = true;
      failRecommended = true;
      await api?.forkTemplateVersion();
      await api?.markTemplateRecommended();
    });

    expect(store.pushNotice).toHaveBeenCalledWith("success", "Template version forked successfully");
    expect(store.pushNotice).toHaveBeenCalledWith("success", "Recommended template updated");
    expect(store.pushNotice).toHaveBeenCalledWith("error", expect.stringContaining("Select a template"));
    expect(store.pushNotice).toHaveBeenCalledWith("error", expect.stringContaining("fork failed"));
    expect(store.pushNotice).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Marking the template recommended failed"),
    );
    expect(store.setStudioError).toHaveBeenCalled();
  });

  it("covers fallback payload and structured error branches", async () => {
    const store = createRichStore();
    store.params.automationToken = "token-1";
    store.params.automationClientId = "client-1";
    store.studioTemplateName = "";
    store.studioOtpCode = "   ";
    store.setSelectedTaskId = vi.fn((updater: string | ((prev: string) => string)) =>
      typeof updater === "function" ? updater("stale-task") : updater,
    );
    store.setSelectedStepId = vi.fn((updater: string | ((prev: string) => string)) =>
      typeof updater === "function" ? updater("") : updater,
    );

    let timelineCalls = 0;
    let draftCalls = 0;
    const reconstructBodyChecks: string[] = [];
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.endsWith("/api/automation/commands")) {
        return Promise.resolve(createResponse({ commands: [] }));
      }
      if (input.includes("/api/automation/tasks?")) {
        return Promise.resolve(createResponse({ tasks: [{ task_id: "task-a" }] }));
      }
      if (input.endsWith("/api/command-tower/latest-flow")) {
        return Promise.resolve(createResponse({ flow_id: "flow-a" }));
      }
      if (input.endsWith("/api/command-tower/latest-flow-draft")) {
        if (init?.method === "PATCH") {
          return Promise.resolve(createResponse({ ok: true }));
        }
        draftCalls += 1;
        if (draftCalls === 2) {
          return Promise.resolve(
            createResponse({
              flow: {
                flow_id: "flow-a",
                session_id: "session-a",
                start_url: "https://example.com",
                steps: [],
              },
            }),
          );
        }
        return Promise.resolve(
          createResponse({
            flow: {
              flow_id: "flow-a",
              session_id: "session-a",
              start_url: "https://example.com",
              steps: [{ step_id: "step-1", action: "click" }],
            },
          }),
        );
      }
      if (input.includes("/api/command-tower/evidence?")) {
        return Promise.resolve(createResponse({ step_id: "step-1" }));
      }
      if (input.endsWith("/api/command-tower/evidence-timeline")) {
        timelineCalls += 1;
        if (timelineCalls === 1) {
          return Promise.resolve(createResponse({ detail: "bad timeline" }, false, 500));
        }
        return Promise.resolve(createResponse({}));
      }
      if (input.endsWith("/api/flows?limit=100")) {
        return Promise.resolve(createResponse({}));
      }
      if (input.endsWith("/api/templates?limit=100")) {
        return Promise.resolve(createResponse({}));
      }
      if (input.endsWith("/api/runs?limit=100")) {
        return Promise.resolve(createResponse({}));
      }
      if (input.endsWith("/api/reconstruction/generate")) {
        reconstructBodyChecks.push(String(init?.body ?? ""));
        return Promise.resolve(createResponse({ template_id: "tmpl-x" }));
      }
      if (input.endsWith("/api/command-tower/orchestrate-from-artifacts")) {
        reconstructBodyChecks.push(String(init?.body ?? ""));
        return Promise.resolve(createResponse({ ok: true }));
      }
      if (input.endsWith("/api/command-tower/replay-latest")) {
        return Promise.resolve(
          createResponse({ task: { task_id: "task-replay-2", command_id: "cmd-1" } }),
        );
      }
      if (input.endsWith("/api/runs")) {
        return Promise.resolve(createResponse("non-object-run-payload"));
      }
      if (input.includes("/api/runs/") && input.endsWith("/resume")) {
        return Promise.resolve(createResponse({ run: { run_id: "run-otp-2" } }));
      }
      if (input.endsWith("/api/profiles/resolve")) {
        return Promise.reject(
          new Error("Conclusion: The path is temporarily degraded\nAction: Check dependency availability\nTroubleshooting entry: Review the service log"),
        );
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      await api?.fetchCommands();
      await api?.fetchTasks();
      await api?.fetchLatestFlowDraft();
      await api?.fetchLatestFlowDraft();
      await api?.fetchEvidenceTimeline();
      await api?.fetchEvidenceTimeline();
      await api?.fetchStudioData();
      await api?.saveFlowDraft();
      await api?.replayLatestFlow();
      await api?.generateReconstruction();
      await api?.orchestrateFromArtifacts();
      store.selectedStudioTemplateId = "";
      await api?.createRun();
      store.selectedStudioTemplateId = "template-1";
      await api?.createRun();
      await api?.submitRunOtp("run-2", "waiting_user", {
        reason_code: "provider_protected_payment_step",
      });
      store.studioOtpCode = "888888";
      await api?.submitRunOtp("run-3", "waiting_user", {
        reason_code: "manual_input_required",
      });
      await api?.resolveProfile();
    });

    expect(store.setCommandState).toHaveBeenCalledWith("empty");
    expect(store.setSelectedTaskId).toHaveBeenCalled();
    expect(store.setStudioFlows).toHaveBeenCalledWith([]);
    expect(store.setStudioTemplates).toHaveBeenCalledWith([]);
    expect(store.setStudioRuns).toHaveBeenCalledWith([]);
    expect(store.setStepEvidence).toHaveBeenCalledWith({ step_id: "step-1" });
    expect(reconstructBodyChecks).toHaveLength(2);
    expect(reconstructBodyChecks).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"template_name":"reconstructed-template"'),
        expect.stringContaining('"template_name":"reconstructed-template"'),
      ]),
    );
    expect(store.setReconstructionError).toHaveBeenCalledWith(
      "Conclusion: The path is temporarily degraded\nAction: Check dependency availability\nTroubleshooting entry: Review the service log",
    );
  });

  it("covers stale step evidence request branch", async () => {
    const store = createRichStore();
    const evidenceResolvers: Array<() => void> = [];
    const fetchMock = vi.fn((input: string) => {
      if (input.includes("/api/command-tower/evidence?")) {
        return new Promise<Response>((resolve) => {
          evidenceResolvers.push(() => resolve(createResponse({ step_id: "step-1" })));
        });
      }
      return Promise.resolve(createResponse({ ok: true }));
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
      const first = api?.fetchStepEvidence("step-1");
      const second = api?.fetchStepEvidence("step-1");
      evidenceResolvers.forEach((flush) => flush());
      await Promise.all([first, second]);
    });

    expect(store.setStepEvidence).toHaveBeenCalledWith({ step_id: "step-1" });
  });
});
