/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const store = {
    uiLocale: "zh-CN" as const,
    params: {
      baseUrl: "http://127.0.0.1:17380",
      startUrl: "",
      successSelector: "#ok",
      modelName: "models/gemini-3.1-pro-preview",
      registerPassword: "",
      automationToken: "",
      automationClientId: "client-001",
      headless: false,
      midsceneStrict: false,
    },
    showOnboarding: false,
    showHelp: false,
    activeView: "launch" as const,
    notices: [{ id: "n1", level: "success" as const, message: "系统已就绪" }],
    dismissNotice: vi.fn(),
    completeOnboarding: vi.fn(),
    restartOnboarding: vi.fn(),
    setShowHelp: vi.fn(),
    setUiLocale: vi.fn(),
    setActiveView: vi.fn(),
    runningCount: 1,
    successCount: 2,
    failedCount: 0,
    isFirstUseActive: false,
    firstUseStage: "configure" as const,
    setFirstUseStage: vi.fn(),
    firstUseProgress: { configValid: true, runTriggered: false, resultSeen: false },
    canCompleteFirstUse: false,
    markFirstUseRunTriggered: vi.fn(),
    markFirstUseResultSeen: vi.fn(),
    completeFirstUse: vi.fn(),
    selectedStudioTemplateId: "",
    studioTemplates: [],
    selectedStepId: "",
    setCommandState: vi.fn(),
    setTaskState: vi.fn(),
    setFeedbackText: vi.fn(),
    addLog: vi.fn(),
    pushNotice: vi.fn(),
    setStudioTemplateName: vi.fn(),
    setStudioSchemaRows: vi.fn(),
    setStudioDefaults: vi.fn(),
    setStudioPolicies: vi.fn(),
    setStudioRunParams: vi.fn(),
    setSelectedStudioFlowId: vi.fn(),
    setStepEvidence: vi.fn(),
    setStepEvidenceError: vi.fn(),
    setConfirmDialog: vi.fn(),
    commandState: "success" as const,
    taskState: "success" as const,
    commands: [],
    activeTab: "all" as const,
    submittingId: "",
    feedbackText: "",
    handleParamsChange: vi.fn(),
    studioTemplateHistory: [],
    setStudioTemplateHistory: vi.fn(),
    setSelectedStudioTemplateId: vi.fn(),
    studioRunParams: {},
    tasks: [],
    selectedTaskId: "",
    taskErrorMessage: "",
    setSelectedTaskId: vi.fn(),
    statusFilter: "all",
    setStatusFilter: vi.fn(),
    commandFilter: "",
    setCommandFilter: vi.fn(),
    taskLimit: 20,
    setTaskLimit: vi.fn(),
    logs: [],
    selectedTask: null,
    terminalRows: 8,
    setTerminalRows: vi.fn(),
    terminalFilter: "all" as const,
    setTerminalFilter: vi.fn(),
    autoScroll: true,
    setAutoScroll: vi.fn(),
    clearLogs: vi.fn(),
    studioRuns: [],
    selectedStudioRunId: "",
    setSelectedStudioRunId: vi.fn(),
    studioOtpCode: "",
    setStudioOtpCode: vi.fn(),
    diagnostics: null,
    alerts: null,
    diagnosticsError: "",
    alertError: "",
    latestFlow: null,
    flowError: "",
    flowDraft: null,
    stepEvidence: null,
    evidenceTimeline: [],
    evidenceTimelineError: "",
    resumeWithPreconditions: false,
    setResumeWithPreconditions: vi.fn(),
    confirmDialog: {
      title: "确认危险命令",
      message: "确定继续吗？",
      onConfirm: vi.fn(),
    },
  };

  const api = {
    fetchCommands: vi.fn(async () => {}),
    fetchTasks: vi.fn(async () => {}),
    fetchDiagnostics: vi.fn(async () => {}),
    fetchAlerts: vi.fn(async () => {}),
    fetchLatestFlow: vi.fn(async () => {}),
    fetchLatestFlowDraft: vi.fn(async () => {}),
    fetchEvidenceTimeline: vi.fn(async () => {}),
    fetchStudioData: vi.fn(async () => {}),
    fetchTemplateHistory: vi.fn(async () => {}),
    fetchStepEvidence: vi.fn(async () => {}),
    runCommand: vi.fn(async () => true),
    forkTemplateVersion: vi.fn(async () => {}),
    markTemplateRecommended: vi.fn(async () => {}),
    promoteTemplate: vi.fn(async () => {}),
    createRun: vi.fn(async () => true),
    cancelTask: vi.fn(async () => {}),
    refreshTasks: vi.fn(async () => {}),
    submitRunOtp: vi.fn(async () => {}),
    refreshDiagnostics: vi.fn(async () => {}),
    saveFlowDraft: vi.fn(async () => {}),
    replayLatestFlow: vi.fn(async () => {}),
    replayStep: vi.fn(async () => {}),
    replayFromStep: vi.fn(async () => {}),
  };

  return { store, api };
});

vi.mock("./hooks/useAppStore", () => ({
  useAppStore: () => hoisted.store,
}));

vi.mock("./hooks/useApiClient", () => ({
  useApiClient: () => hoisted.api,
}));

vi.mock("./hooks/usePolling", () => ({
  usePolling: () => {},
}));

vi.mock("./views/QuickLaunchView", () => ({
  default: ({ locale }: { locale: string }) => <div>{`quick-launch:${locale}`}</div>,
}));

vi.mock("./components/ConsoleHeader", () => ({
  default: ({ locale }: { locale: string }) => <div>{`console-header:${locale}`}</div>,
}));

vi.mock("./components/ToastStack", () => ({
  default: ({ locale }: { locale: string }) => <div>{`toast-stack:${locale}`}</div>,
}));

vi.mock("./components/ConfirmDialog", () => ({
  default: ({
    locale,
    confirmLabel,
    cancelLabel,
  }: {
    locale: string;
    confirmLabel: string;
    cancelLabel: string;
  }) => <div>{`confirm-dialog:${locale}:${confirmLabel}:${cancelLabel}`}</div>,
}));

import App from "./App";

describe("App locale shell integration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.pushState({}, "", "/register");
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    document.documentElement.removeAttribute("data-uiq-locale");
    document.documentElement.lang = "";
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("wires the top-level shell into zh-CN locale surfaces", () => {
    root = createRoot(container);

    act(() => {
      root.render(<App />);
    });

    const text = container.textContent ?? "";
    expect(text).toContain("跳过至主要内容");
    expect(text).toContain("注册场景");
    expect(text).toContain("quick-launch:zh-CN");
    expect(text).toContain("console-header:zh-CN");
    expect(text).toContain("toast-stack:zh-CN");
    expect(text).toContain("confirm-dialog:zh-CN:确认:取消");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.getAttribute("data-uiq-locale")).toBe("zh-CN");
  });
});
