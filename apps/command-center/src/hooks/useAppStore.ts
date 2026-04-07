import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveUiLocale,
  UI_LOCALE_STORAGE_KEY,
  type UiLocale,
} from "../i18n/uiLocale";
import type { ParamsState } from "../components/ParamsPanel";
import type {
  ActionState,
  AlertsPayload,
  Command,
  CommandCategory,
  CommandState,
  DiagnosticsPayload,
  EvidenceTimelineItem,
  FlowEditableDraft,
  FlowPreviewPayload,
  LogEntry,
  LogLevel,
  ProfileResolvePayload,
  ReconstructionArtifactsPayload,
  ReconstructionGeneratePayload,
  ReconstructionPreviewPayload,
  StepEvidencePayload,
  Task,
  TaskState,
  UiNotice,
  UniversalFlow,
  UniversalRun,
  UniversalTemplate,
} from "../types";

const MAX_LOG_SIZE = 500;

export type StudioSchemaRow = {
  key: string;
  type: "string" | "secret" | "enum" | "regex" | "email";
  required: boolean;
  description: string;
  enum_values: string;
  pattern: string;
};

export type StudioPolicies = {
  retries: number;
  timeout_seconds: number;
  otp: {
    required: boolean;
    provider: "manual" | "gmail" | "imap" | "vonage";
    timeout_seconds: number;
    regex: string;
    sender_filter: string;
    subject_filter: string;
  };
};

export type AppView = "launch" | "tasks" | "workshop" | "review";
export type FirstUseStage = "welcome" | "configure" | "run" | "verify";
type FirstUseProgress = {
  configValid: boolean;
  runTriggered: boolean;
  resultSeen: boolean;
};

const FIRST_USE_DONE_KEY = "ab_first_use_done";
const FIRST_USE_STAGE_KEY = "ab_first_use_stage";
const FIRST_USE_PROGRESS_KEY = "ab_first_use_progress";
const AUTOMATION_CLIENT_ID_KEY = "ab_automation_client_id";
const VISUAL_DETERMINISTIC_CLIENT_ID = "client-visual-ci";
const LEGACY_DEFAULT_BASE_URL = "http://127.0.0.1:17380";

const FIRST_USE_STAGE_INDEX: Record<FirstUseStage, number> = {
  welcome: 0,
  configure: 1,
  run: 2,
  verify: 3,
};

function isValidHttpUrl(raw: string) {
  if (!raw.trim()) {
    return false;
  }
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isFirstUseConfigValid(params: ParamsState) {
  if (!isValidHttpUrl(params.baseUrl)) {
    return false;
  }
  if (params.startUrl.trim() && !isValidHttpUrl(params.startUrl)) {
    return false;
  }
  return Boolean(params.successSelector.trim());
}

function clampFirstUseStage(stage: FirstUseStage, progress: FirstUseProgress) {
  const maxUnlocked: FirstUseStage = progress.runTriggered
    ? "verify"
    : progress.configValid
      ? "run"
      : "configure";
  if (stage === "welcome") {
    return "welcome";
  }
  return FIRST_USE_STAGE_INDEX[stage] <= FIRST_USE_STAGE_INDEX[maxUnlocked] ? stage : maxUnlocked;
}

function isCompletedTaskStatus(status: Task["status"]) {
  return status === "success" || status === "failed";
}

function isCompletedRunStatus(status: UniversalRun["status"]) {
  return status === "success" || status === "failed";
}

function createAutomationClientId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `client-${Date.now()}`;
  }
}

function readRuntimeOrigin() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin;
}

function isVisualSnapshotMode() {
  if (typeof document === "undefined") {
    return false;
  }
  return document.documentElement.getAttribute("data-uiq-visual") === "1";
}

function isCiRuntime() {
  const env = import.meta.env as ImportMetaEnv & {
    VITEST?: boolean;
    VITE_CI?: string;
  };
  if (env.VITEST) {
    return true;
  }
  if (env.VITE_CI?.trim().toLowerCase() === "true") {
    return true;
  }
  const maybeProcess = (globalThis as { process?: { env?: { CI?: string } } }).process;
  return maybeProcess?.env?.CI === "true";
}

export function resolveDefaultBaseUrl(defaultFromEnv: string | undefined, runtimeOrigin: string) {
  const explicit = defaultFromEnv?.trim();
  if (explicit) {
    return explicit;
  }
  const sameOrigin = runtimeOrigin.trim();
  if (isValidHttpUrl(sameOrigin)) {
    return sameOrigin;
  }
  return LEGACY_DEFAULT_BASE_URL;
}

function shouldUseDeterministicClientId() {
  return isVisualSnapshotMode() || isCiRuntime();
}

export function resolveAutomationClientId(
  storedClientId: string | undefined,
  deterministicMode: boolean,
) {
  if (deterministicMode) {
    return VISUAL_DETERMINISTIC_CLIENT_ID;
  }
  if (storedClientId?.trim()) {
    return storedClientId.trim();
  }
  return createAutomationClientId();
}

function readAutomationClientId() {
  try {
    const stored = localStorage.getItem(AUTOMATION_CLIENT_ID_KEY)?.trim();
    const generated = resolveAutomationClientId(stored, shouldUseDeterministicClientId());
    localStorage.setItem(AUTOMATION_CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return resolveAutomationClientId(undefined, shouldUseDeterministicClientId());
  }
}

function readStoredFirstUseProgress(defaultConfigValid: boolean): FirstUseProgress {
  try {
    const raw = localStorage.getItem(FIRST_USE_PROGRESS_KEY);
    if (!raw) {
      return { configValid: defaultConfigValid, runTriggered: false, resultSeen: false };
    }
    const parsed = JSON.parse(raw) as Partial<FirstUseProgress>;
    return {
      configValid: defaultConfigValid,
      runTriggered: Boolean(parsed.runTriggered),
      resultSeen: Boolean(parsed.resultSeen),
    };
  } catch {
    return { configValid: defaultConfigValid, runTriggered: false, resultSeen: false };
  }
}

function readStoredFirstUseStage(progress: FirstUseProgress): FirstUseStage {
  try {
    const raw = localStorage.getItem(FIRST_USE_STAGE_KEY);
    if (!raw) {
      return "welcome";
    }
    if (raw !== "welcome" && raw !== "configure" && raw !== "run" && raw !== "verify") {
      return "welcome";
    }
    return clampFirstUseStage(raw, progress);
  } catch {
    return "welcome";
  }
}

export function useAppStore() {
  const defaultBaseUrl = resolveDefaultBaseUrl(
    import.meta.env.VITE_DEFAULT_BASE_URL as string | undefined,
    readRuntimeOrigin(),
  );
  const initialParams: ParamsState = {
    baseUrl: defaultBaseUrl,
    startUrl: "",
    successSelector: "#result.ok",
    modelName: "models/gemini-3.1-pro-preview",
    geminiApiKey: "",
    registerPassword: "",
    automationToken: "",
    automationClientId: readAutomationClientId(),
    headless: false,
    midsceneStrict: false,
  };
  const defaultConfigValid = isFirstUseConfigValid(initialParams);
  // --- View ---
  const [activeView, setActiveView] = useState<AppView>("launch");
  const [uiLocale, setUiLocaleState] = useState<UiLocale>(() => {
    try {
      return resolveUiLocale(
        localStorage.getItem(UI_LOCALE_STORAGE_KEY),
        typeof navigator !== "undefined" ? navigator.language : undefined,
      );
    } catch {
      return resolveUiLocale(undefined, typeof navigator !== "undefined" ? navigator.language : undefined);
    }
  });
  const [isFirstUseActive, setIsFirstUseActive] = useState(() => {
    try {
      return localStorage.getItem(FIRST_USE_DONE_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const [firstUseProgress, setFirstUseProgress] = useState<FirstUseProgress>(() =>
    readStoredFirstUseProgress(defaultConfigValid),
  );
  const [firstUseStageState, setFirstUseStageState] = useState<FirstUseStage>(() =>
    readStoredFirstUseStage(readStoredFirstUseProgress(defaultConfigValid)),
  );
  const hasFirstUseOutcomeRef = useRef(false);
  const hasFirstUseViewedOutcomeRef = useRef(false);

  // --- Onboarding & Help ---
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return localStorage.getItem("ab_onboarding_done") !== "1";
    } catch {
      return true;
    }
  });
  const [showHelp, setShowHelp] = useState(false);

  const completeOnboarding = useCallback(() => {
    setShowOnboarding(false);
    try {
      localStorage.setItem("ab_onboarding_done", "1");
    } catch {
      /* noop */
    }
  }, []);

  const restartOnboarding = useCallback(() => {
    setShowOnboarding(true);
    try {
      localStorage.removeItem("ab_onboarding_done");
    } catch {
      /* noop */
    }
  }, []);

  const setFirstUseStage = useCallback(
    (stage: FirstUseStage) => {
      setFirstUseStageState(clampFirstUseStage(stage, firstUseProgress));
    },
    [firstUseProgress],
  );

  const markFirstUseRunTriggered = useCallback(() => {
    if (!isFirstUseActive) {
      return;
    }
    setFirstUseProgress((prev) => ({ ...prev, runTriggered: true }));
    setFirstUseStageState("verify");
  }, [isFirstUseActive]);

  const markFirstUseResultSeen = useCallback(() => {
    if (!isFirstUseActive) {
      return;
    }
    if (hasFirstUseOutcomeRef.current && !hasFirstUseViewedOutcomeRef.current) {
      return;
    }
    setFirstUseProgress((prev) => ({ ...prev, runTriggered: true, resultSeen: true }));
    setFirstUseStageState("verify");
  }, [isFirstUseActive]);

  const canCompleteFirstUse = useMemo(
    () =>
      firstUseProgress.configValid && firstUseProgress.runTriggered && firstUseProgress.resultSeen,
    [firstUseProgress.configValid, firstUseProgress.resultSeen, firstUseProgress.runTriggered],
  );

  const completeFirstUse = useCallback(() => {
    if (!firstUseProgress.configValid) {
      setFirstUseStageState("configure");
      return;
    }
    if (!firstUseProgress.runTriggered) {
      setFirstUseStageState("run");
      return;
    }
    if (!firstUseProgress.resultSeen) {
      setFirstUseStageState("verify");
      return;
    }
    setIsFirstUseActive(false);
    setFirstUseStageState("verify");
    try {
      localStorage.setItem(FIRST_USE_DONE_KEY, "1");
      localStorage.removeItem(FIRST_USE_STAGE_KEY);
      localStorage.removeItem(FIRST_USE_PROGRESS_KEY);
    } catch {
      /* noop */
    }
  }, [firstUseProgress.configValid, firstUseProgress.resultSeen, firstUseProgress.runTriggered]);

  // --- Core data ---
  const [commands, setCommands] = useState<Command[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");

  // --- UI states ---
  const [commandState, setCommandState] = useState<CommandState>("loading");
  const [taskState, setTaskState] = useState<TaskState>("loading");
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [feedbackText, setFeedbackText] = useState("Waiting for a command");
  const [taskSyncError, setTaskSyncError] = useState("");
  const [submittingId, setSubmittingId] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | CommandCategory>("all");

  // --- Task filters ---
  const [statusFilter, setStatusFilter] = useState("all");
  const [commandFilter, setCommandFilter] = useState("");
  const [taskLimit, setTaskLimit] = useState(100);

  // --- Terminal ---
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [terminalRows, setTerminalRows] = useState(14);
  const [terminalFilter, setTerminalFilter] = useState<"all" | LogLevel>("all");
  const [autoScroll, setAutoScroll] = useState(true);

  // --- Toasts ---
  const [notices, setNotices] = useState<UiNotice[]>([]);

  // --- Diagnostics ---
  const [diagnostics, setDiagnostics] = useState<DiagnosticsPayload | null>(null);
  const [alerts, setAlerts] = useState<AlertsPayload | null>(null);
  const [latestFlow, setLatestFlow] = useState<FlowPreviewPayload | null>(null);
  const [flowDraft, setFlowDraft] = useState<FlowEditableDraft | null>(null);
  const [selectedStepId, setSelectedStepId] = useState("");
  const [stepEvidence, setStepEvidence] = useState<StepEvidencePayload | null>(null);
  const [evidenceTimeline, setEvidenceTimeline] = useState<EvidenceTimelineItem[]>([]);
  const [evidenceTimelineError, setEvidenceTimelineError] = useState("");
  const [resumeWithPreconditions, setResumeWithPreconditions] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState("");
  const [alertError, setAlertError] = useState("");
  const [flowError, setFlowError] = useState("");
  const [stepEvidenceError, setStepEvidenceError] = useState("");
  const [reconstructionArtifacts, setReconstructionArtifacts] =
    useState<ReconstructionArtifactsPayload>({});
  const [reconstructionMode, setReconstructionMode] = useState<"gemini">("gemini");
  const [reconstructionStrategy, setReconstructionStrategy] = useState<
    "strict" | "balanced" | "aggressive"
  >("balanced");
  const [reconstructionPreview, setReconstructionPreview] =
    useState<ReconstructionPreviewPayload | null>(null);
  const [reconstructionGenerated, setReconstructionGenerated] =
    useState<ReconstructionGeneratePayload | null>(null);
  const [profileResolved, setProfileResolved] = useState<ProfileResolvePayload | null>(null);
  const [reconstructionError, setReconstructionError] = useState("");

  // --- Studio ---
  const [studioError, setStudioError] = useState("");
  const [studioFlows, setStudioFlows] = useState<UniversalFlow[]>([]);
  const [studioTemplates, setStudioTemplates] = useState<UniversalTemplate[]>([]);
  const [studioTemplateHistory, setStudioTemplateHistory] = useState<UniversalTemplate[]>([]);
  const [studioRuns, setStudioRuns] = useState<UniversalRun[]>([]);
  const [selectedStudioFlowId, setSelectedStudioFlowId] = useState("");
  const [selectedStudioTemplateId, setSelectedStudioTemplateId] = useState("");
  const [selectedStudioRunId, setSelectedStudioRunId] = useState("");
  const [studioTemplateName, setStudioTemplateName] = useState("universal-template");
  const [studioSchemaRows, setStudioSchemaRows] = useState<StudioSchemaRow[]>([
    { key: "email", type: "email", required: true, description: "", enum_values: "", pattern: "" },
    {
      key: "password",
      type: "secret",
      required: true,
      description: "",
      enum_values: "",
      pattern: "",
    },
    { key: "otp", type: "secret", required: false, description: "", enum_values: "", pattern: "" },
  ]);
  const [studioDefaults, setStudioDefaults] = useState<Record<string, string>>({
    email: "demo@example.com",
  });
  const [studioPolicies, setStudioPolicies] = useState<StudioPolicies>({
    retries: 0,
    timeout_seconds: 120,
    otp: {
      required: false,
      provider: "manual",
      timeout_seconds: 120,
      regex: "\\b(\\d{6})\\b",
      sender_filter: "",
      subject_filter: "",
    },
  });
  const [studioRunParams, setStudioRunParams] = useState<Record<string, string>>({
    email: "demo@example.com",
  });
  const [studioRunInputByRunId, setStudioRunInputByRunId] = useState<Record<string, string>>({});
  const [studioOtpCode, setStudioOtpCodeState] = useState("");
  const setStudioOtpCode = useCallback(
    (value: string | ((prev: string) => string)) => {
      setStudioOtpCodeState((prev) => {
        const resolved = typeof value === "function" ? value(prev) : value;
        if (selectedStudioRunId) {
          setStudioRunInputByRunId((previousMap) => ({
            ...previousMap,
            [selectedStudioRunId]: resolved,
          }));
        }
        return resolved;
      });
    },
    [selectedStudioRunId],
  );

  // --- Params ---
  const [params, setParams] = useState<ParamsState>(initialParams);

  // --- Confirm dialog ---
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // ---- Helpers ----
  const addLog = useCallback((level: LogLevel, message: string, commandId?: string) => {
    setLogs((prev) => {
      const next = [
        ...prev,
        { id: crypto.randomUUID(), ts: new Date().toISOString(), level, message, commandId },
      ];
      return next.length > MAX_LOG_SIZE ? next.slice(-MAX_LOG_SIZE) : next;
    });
  }, []);

  const pushNotice = useCallback((level: LogLevel, message: string) => {
    const id = crypto.randomUUID();
    setNotices((prev) => [...prev, { id, level, message }]);
    window.setTimeout(() => {
      setNotices((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  const handleParamsChange = useCallback((patch: Partial<ParamsState>) => {
    setParams((prev) => ({ ...prev, ...patch }));
  }, []);

  const setUiLocale = useCallback((locale: UiLocale) => {
    setUiLocaleState(locale);
  }, []);

  useEffect(() => {
    if (!isFirstUseActive) {
      return;
    }
    const configValid = isFirstUseConfigValid(params);
    setFirstUseProgress((prev) =>
      prev.configValid === configValid ? prev : { ...prev, configValid },
    );
  }, [isFirstUseActive, params]);

  useEffect(() => {
    if (!isFirstUseActive) {
      return;
    }
    const stage = clampFirstUseStage(firstUseStageState, firstUseProgress);
    if (stage !== firstUseStageState) {
      setFirstUseStageState(stage);
      return;
    }
    try {
      localStorage.setItem(FIRST_USE_STAGE_KEY, stage);
      localStorage.setItem(
        FIRST_USE_PROGRESS_KEY,
        JSON.stringify({
          runTriggered: firstUseProgress.runTriggered,
          resultSeen: firstUseProgress.resultSeen,
        }),
      );
    } catch {
      /* noop */
    }
  }, [firstUseProgress, firstUseStageState, isFirstUseActive]);

  useEffect(() => {
    if (!selectedStudioRunId) {
      setStudioOtpCodeState("");
      return;
    }
    setStudioOtpCodeState(studioRunInputByRunId[selectedStudioRunId] ?? "");
  }, [selectedStudioRunId, studioRunInputByRunId]);

  useEffect(() => {
    const clientId = params.automationClientId.trim();
    if (!clientId) {
      return;
    }
    try {
      localStorage.setItem(AUTOMATION_CLIENT_ID_KEY, clientId);
    } catch {
      /* noop */
    }
  }, [params.automationClientId]);

  useEffect(() => {
    try {
      localStorage.setItem(UI_LOCALE_STORAGE_KEY, uiLocale);
    } catch {
      /* noop */
    }
  }, [uiLocale]);

  // ---- Derived ----
  const selectedTask = useMemo(
    () => tasks.find((t) => t.task_id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );
  const selectedStudioRun = useMemo(
    () => studioRuns.find((run) => run.run_id === selectedStudioRunId) ?? null,
    [selectedStudioRunId, studioRuns],
  );
  const hasFirstUseOutcome = useMemo(
    () =>
      tasks.some((task) => isCompletedTaskStatus(task.status)) ||
      studioRuns.some((run) => isCompletedRunStatus(run.status)),
    [studioRuns, tasks],
  );
  const hasViewedFirstUseOutcome = useMemo(() => {
    if (activeView !== "tasks") {
      return false;
    }
    return (
      Boolean(selectedTask && isCompletedTaskStatus(selectedTask.status)) ||
      Boolean(selectedStudioRun && isCompletedRunStatus(selectedStudioRun.status))
    );
  }, [activeView, selectedStudioRun, selectedTask]);
  useEffect(() => {
    hasFirstUseOutcomeRef.current = hasFirstUseOutcome;
    hasFirstUseViewedOutcomeRef.current = hasViewedFirstUseOutcome;
    if (!isFirstUseActive || !hasFirstUseOutcome || !hasViewedFirstUseOutcome) {
      return;
    }
    setFirstUseProgress((prev) =>
      prev.resultSeen ? prev : { ...prev, runTriggered: true, resultSeen: true },
    );
    setFirstUseStageState("verify");
  }, [hasFirstUseOutcome, hasViewedFirstUseOutcome, isFirstUseActive]);
  const runningCount = useMemo(() => tasks.filter((t) => t.status === "running").length, [tasks]);
  const failedCount = useMemo(() => tasks.filter((t) => t.status === "failed").length, [tasks]);
  const successCount = useMemo(() => tasks.filter((t) => t.status === "success").length, [tasks]);
  const taskErrorMessage = taskSyncError || (taskState === "error" ? feedbackText : "");

  return {
    // View
    activeView,
    setActiveView,
    uiLocale,
    setUiLocale,
    isFirstUseActive,
    setIsFirstUseActive,
    firstUseStage: firstUseStageState,
    setFirstUseStage,
    firstUseProgress,
    canCompleteFirstUse,
    markFirstUseRunTriggered,
    markFirstUseResultSeen,
    completeFirstUse,
    // Onboarding & Help
    showOnboarding,
    completeOnboarding,
    restartOnboarding,
    showHelp,
    setShowHelp,
    // Core
    commands,
    setCommands,
    tasks,
    setTasks,
    selectedTaskId,
    setSelectedTaskId,
    // UI
    commandState,
    setCommandState,
    taskState,
    setTaskState,
    actionState,
    setActionState,
    feedbackText,
    setFeedbackText,
    taskSyncError,
    setTaskSyncError,
    submittingId,
    setSubmittingId,
    activeTab,
    setActiveTab,
    // Task filters
    statusFilter,
    setStatusFilter,
    commandFilter,
    setCommandFilter,
    taskLimit,
    setTaskLimit,
    // Terminal
    logs,
    terminalRows,
    setTerminalRows,
    terminalFilter,
    setTerminalFilter,
    autoScroll,
    setAutoScroll,
    // Toasts
    notices,
    // Diagnostics
    diagnostics,
    setDiagnostics,
    alerts,
    setAlerts,
    latestFlow,
    setLatestFlow,
    flowDraft,
    setFlowDraft,
    selectedStepId,
    setSelectedStepId,
    stepEvidence,
    setStepEvidence,
    evidenceTimeline,
    setEvidenceTimeline,
    evidenceTimelineError,
    setEvidenceTimelineError,
    resumeWithPreconditions,
    setResumeWithPreconditions,
    diagnosticsError,
    setDiagnosticsError,
    alertError,
    setAlertError,
    flowError,
    setFlowError,
    stepEvidenceError,
    setStepEvidenceError,
    reconstructionArtifacts,
    setReconstructionArtifacts,
    reconstructionMode,
    setReconstructionMode,
    reconstructionStrategy,
    setReconstructionStrategy,
    reconstructionPreview,
    setReconstructionPreview,
    reconstructionGenerated,
    setReconstructionGenerated,
    profileResolved,
    setProfileResolved,
    reconstructionError,
    setReconstructionError,
    // Studio
    studioError,
    setStudioError,
    studioFlows,
    setStudioFlows,
    studioTemplates,
    setStudioTemplates,
    studioTemplateHistory,
    setStudioTemplateHistory,
    studioRuns,
    setStudioRuns,
    selectedStudioFlowId,
    setSelectedStudioFlowId,
    selectedStudioTemplateId,
    setSelectedStudioTemplateId,
    selectedStudioRunId,
    setSelectedStudioRunId,
    studioTemplateName,
    setStudioTemplateName,
    studioSchemaRows,
    setStudioSchemaRows,
    studioDefaults,
    setStudioDefaults,
    studioPolicies,
    setStudioPolicies,
    studioRunParams,
    setStudioRunParams,
    studioOtpCode,
    setStudioOtpCode,
    // Params
    params,
    setParams,
    handleParamsChange,
    // Confirm
    confirmDialog,
    setConfirmDialog,
    // Helpers
    addLog,
    pushNotice,
    dismissNotice,
    clearLogs,
    // Derived
    selectedTask,
    runningCount,
    failedCount,
    successCount,
    taskErrorMessage,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;
