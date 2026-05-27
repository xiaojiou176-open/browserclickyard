import { useCallback, useEffect, useRef } from "react";
import type {
  AlertsPayload,
  Command,
  DiagnosticsPayload,
  EvidenceTimelinePayload,
  FetchTaskOptions,
  FlowEditableDraft,
  FlowPreviewPayload,
  ProfileResolvePayload,
  ReconstructionGeneratePayload,
  ReconstructionPreviewPayload,
  StepEvidencePayload,
  Task,
  UniversalFlow,
  UniversalRun,
  UniversalTemplate,
} from "../types";
import {
  type ApiRequestInit,
  DEFAULT_REQUEST_TIMEOUT_MS,
  formatApiError,
  mergeAbortSignal,
  readErrorDetail,
  readSuccessPayload,
} from "../utils/api";
import type { AppStore, StudioSchemaRow } from "./useAppStore";

export function buildApiUrl(baseUrl: string, path: string): string {
  const rawPath = path.trim();
  if (!rawPath) {
    return path;
  }
  if (/^https?:\/\//i.test(rawPath)) {
    return rawPath;
  }
  const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  const rawBaseUrl = baseUrl.trim();
  if (!rawBaseUrl) {
    return normalizedPath;
  }

  if (rawBaseUrl.startsWith("/")) {
    const normalizedPrefix = rawBaseUrl === "/" ? "" : rawBaseUrl.replace(/\/+$/, "");
    return `${normalizedPrefix}${normalizedPath}`;
  }

  try {
    const parsedBaseUrl = new URL(rawBaseUrl);
    if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
      return normalizedPath;
    }
    return new URL(normalizedPath, parsedBaseUrl).toString();
  } catch {
    return normalizedPath;
  }
}

function resolveApiBaseUrl(legacyBaseUrl: string): string {
  const explicitApiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  if (explicitApiBase) {
    return explicitApiBase;
  }
  const isVitestRuntime = Boolean((import.meta.env as ImportMetaEnv & { VITEST?: boolean }).VITEST);
  if (!isVitestRuntime && typeof window !== "undefined" && window.location.origin.trim()) {
    return window.location.origin;
  }
  return legacyBaseUrl;
}

function isStudioEmptyBootstrapResponse(response: Response): boolean {
  return response.status === 404;
}

export function useApiClient(store: AppStore) {
  const latestStepEvidenceRequestIdRef = useRef(0);
  const apiBaseUrlRef = useRef(resolveApiBaseUrl(store.params.baseUrl));

  useEffect(() => {
    apiBaseUrlRef.current = resolveApiBaseUrl(store.params.baseUrl);
  }, [store.params.baseUrl]);

  const normalizeTransportError = useCallback((message: string) => {
    const normalized = message.trim();
    if (!normalized) {
      return "The backend service is temporarily unavailable.";
    }
    if (/failed to fetch|networkerror|load failed|econnrefused|fetch failed/i.test(normalized)) {
      return "The backend connection failed.";
    }
    return normalized;
  }, []);

  const unwrapRunPayload = useCallback((payload: unknown): UniversalRun | null => {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const candidate = payload as { run?: unknown; run_id?: unknown };
    if (candidate.run && typeof candidate.run === "object") {
      return candidate.run as UniversalRun;
    }
    if (typeof candidate.run_id === "string") {
      return payload as UniversalRun;
    }
    return null;
  }, []);

  const toObjectPayload = useCallback((payload: unknown): Record<string, unknown> | null => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload as Record<string, unknown>;
  }, []);

  const formatActionableError = useCallback(
    (
      message: string,
      action = "Correct the current input and try again.",
      entry = "Inspect the Task Center run log and the browser developer-tools network requests.",
    ) => {
      const normalized = normalizeTransportError(message);
      if (!normalized) {
        return "";
      }
      if (
        normalized.includes("Conclusion:") &&
        normalized.includes("Action:") &&
        normalized.includes("Troubleshooting entry:")
      ) {
        return normalized;
      }
      if (
        normalized.includes("Issue:") &&
        normalized.includes("Recommended action:") &&
        normalized.includes("Troubleshooting entry:")
      ) {
        return normalized;
      }
      return [`Issue: ${normalized}`, `Recommended action: ${action}`, `Troubleshooting entry: ${entry}`].join("\n");
    },
    [normalizeTransportError],
  );

  const buildHeaders = useCallback(() => {
    const headers: Record<string, string> = {};
    const token = store.params.automationToken.trim();
    if (token) {
      headers["x-automation-token"] = token;
      const clientId = store.params.automationClientId.trim();
      if (clientId) {
        headers["x-automation-client-id"] = clientId;
      }
    }
    return headers;
  }, [store.params.automationClientId, store.params.automationToken]);

  const apiFetch = useCallback(async (path: string, init?: ApiRequestInit) => {
    const { timeoutMs, signal: externalSignal, ...fetchInit } = init ?? {};
    const timeoutWithDefault = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { signal, cleanup } = mergeAbortSignal(timeoutWithDefault, externalSignal ?? undefined);
    try {
      return await fetch(buildApiUrl(apiBaseUrlRef.current, path), {
        ...fetchInit,
        signal,
      });
    } finally {
      cleanup();
    }
  }, []);

  const assertResponseOk = useCallback(async (response: Response, message: string) => {
    if (response.ok) {
      return;
    }
    throw new Error(formatApiError(message, await readErrorDetail(response)));
  }, []);

  const requestJson = useCallback(
    async <T>(path: string, message: string, init?: ApiRequestInit): Promise<T> => {
      const response = await apiFetch(path, init);
      await assertResponseOk(response, message);
      return (await readSuccessPayload(response)) as T;
    },
    [apiFetch, assertResponseOk],
  );

  const runAction = useCallback(
    async <T>(
      fallbackMessage: string,
      onError: (formatted: string) => void,
      action: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : fallbackMessage;
        const formatted = formatActionableError(message);
        onError(formatted);
        return null;
      }
    },
    [formatActionableError],
  );

  const fetchCommands = useCallback(async () => {
    const data = await requestJson<{ commands: Command[] }>(
      "/api/automation/commands",
      "Loading the command list failed",
      {
        headers: buildHeaders(),
      },
    );
    store.setCommands(data.commands);
    store.setCommandState(data.commands.length > 0 ? "success" : "empty");
  }, [buildHeaders, requestJson, store]);

  const fetchTasks = useCallback(
    async ({ background = false }: FetchTaskOptions = {}) => {
      if (!background) {
        store.setTaskState("loading");
      }
      const urlParams = new URLSearchParams();
      if (store.statusFilter !== "all") {
        urlParams.set("status", store.statusFilter);
      }
      if (store.commandFilter.trim()) {
        urlParams.set("command_id", store.commandFilter.trim());
      }
      urlParams.set("limit", String(store.taskLimit));
      const data = await requestJson<{ tasks: Task[] }>(
        `/api/automation/tasks?${urlParams.toString()}`,
        "Loading the task list failed",
        {
          headers: buildHeaders(),
        },
      );
      store.setTasks(data.tasks);
      store.setTaskState(data.tasks.length > 0 ? "success" : "empty");
      store.setTaskSyncError("");
      store.setSelectedTaskId((prev) => {
        if (prev && !data.tasks.some((t) => t.task_id === prev)) {
          return "";
        }
        if (!prev && data.tasks[0]) {
          return data.tasks[0].task_id;
        }
        return prev;
      });
    },
    [buildHeaders, requestJson, store],
  );

  const fetchDiagnostics = useCallback(async () => {
    try {
      const response = await apiFetch("/health/diagnostics", { headers: buildHeaders() });
      if (!response.ok) {
        store.setDiagnosticsError(
          formatActionableError(
            formatApiError("Diagnostics failed", await readErrorDetail(response)),
            "Check the service state and retry.",
            "Inspect the health panel and backend diagnostics log.",
          ),
        );
        store.setDiagnostics(null);
        return;
      }
      store.setDiagnosticsError("");
      const payload = await readSuccessPayload(response);
      store.setDiagnostics((toObjectPayload(payload) as DiagnosticsPayload | null) ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Diagnostics failed";
      store.setDiagnosticsError(
        formatActionableError(
          formatApiError("Diagnostics failed", { status: 0, detail: message, requestId: null }),
          "Check the service state and retry.",
          "Inspect the health panel and backend diagnostics log.",
        ),
      );
      store.setDiagnostics(null);
    }
  }, [apiFetch, buildHeaders, formatActionableError, store, toObjectPayload]);

  const fetchAlerts = useCallback(async () => {
    try {
      const response = await apiFetch("/health/alerts", { headers: buildHeaders() });
      if (!response.ok) {
        store.setAlertError(
          formatActionableError(
            formatApiError("Alerts request failed", await readErrorDetail(response)),
            "Confirm the alert configuration and service connection, then retry.",
            "Inspect the alert panel and backend log.",
          ),
        );
        store.setAlerts(null);
        return;
      }
      store.setAlertError("");
      const payload = await readSuccessPayload(response);
      store.setAlerts((toObjectPayload(payload) as AlertsPayload | null) ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Alerts request failed";
      store.setAlertError(
        formatActionableError(
          formatApiError("Alerts request failed", { status: 0, detail: message, requestId: null }),
          "Confirm the alert configuration and service connection, then retry.",
          "Inspect the alert panel and backend log.",
        ),
      );
      store.setAlerts(null);
    }
  }, [apiFetch, buildHeaders, formatActionableError, store, toObjectPayload]);

  const fetchLatestFlow = useCallback(async () => {
    const response = await apiFetch("/api/command-tower/latest-flow", { headers: buildHeaders() });
    if (!response.ok) {
      store.setFlowError(
        formatActionableError(
          formatApiError("Flow preview failed", await readErrorDetail(response)),
          "Check the recording output and reload.",
          "Inspect Flow Workshop and backend orchestration logs.",
        ),
      );
      store.setLatestFlow(null);
      return;
    }
    store.setFlowError("");
    const payload = await readSuccessPayload(response);
    store.setLatestFlow((toObjectPayload(payload) as FlowPreviewPayload | null) ?? null);
  }, [apiFetch, buildHeaders, formatActionableError, store, toObjectPayload]);

  const fetchLatestFlowDraft = useCallback(async () => {
    const response = await apiFetch("/api/command-tower/latest-flow-draft", {
      headers: buildHeaders(),
    });
    if (!response.ok) {
      store.setFlowError(
        formatActionableError(
          formatApiError("Loading the flow draft failed", await readErrorDetail(response)),
          "Confirm the flow draft is available and retry.",
          "Inspect the Flow Workshop draft area and backend orchestration logs.",
        ),
      );
      store.setFlowDraft(null);
      return;
    }
    const payload = toObjectPayload(await readSuccessPayload(response));
    store.setFlowError("");
    if (!payload || !payload.flow || typeof payload.flow !== "object") {
      store.setFlowDraft(null);
      return;
    }
    const flow = payload.flow as Partial<FlowEditableDraft>;
    if (!flow.start_url || !Array.isArray(flow.steps)) {
      store.setFlowDraft(null);
      return;
    }
    const steps = flow.steps as FlowEditableDraft["steps"];
    store.setFlowDraft({
      flow_id: flow.flow_id,
      session_id: flow.session_id,
      start_url: String(flow.start_url),
      generated_at: flow.generated_at,
      source_event_count: flow.source_event_count,
      steps,
    });
    store.setSelectedStepId((prev) => {
      if (prev && steps.some((step) => step.step_id === prev)) {
        return prev;
      }
      return steps[0]?.step_id ?? "";
    });
  }, [apiFetch, buildHeaders, formatActionableError, store, toObjectPayload]);

  const fetchStepEvidence = useCallback(
    async (stepId: string) => {
      const requestId = ++latestStepEvidenceRequestIdRef.current;
      const isLatestRequest = () => requestId === latestStepEvidenceRequestIdRef.current;
      const step = stepId.trim();
      if (!step) {
        if (!isLatestRequest()) {
          return;
        }
        store.setStepEvidence(null);
        store.setStepEvidenceError("");
        return;
      }
      if (!store.evidenceTimeline.some((item) => item.step_id === step)) {
        if (!isLatestRequest()) {
          return;
        }
        store.setStepEvidence(null);
        store.setStepEvidenceError("");
        return;
      }
      const response = await apiFetch(
        `/api/command-tower/evidence?step_id=${encodeURIComponent(step)}`,
        {
          headers: buildHeaders(),
        },
      );
      if (!isLatestRequest()) {
        return;
      }
      if (!response.ok) {
        if (response.status === 404) {
          store.setStepEvidence(null);
          store.setStepEvidenceError("");
          return;
        }
        store.setStepEvidenceError(
          formatActionableError(
          formatApiError("Loading step evidence failed", await readErrorDetail(response)),
          "Run the related step before loading its evidence.",
          "Inspect the step detail view and the backend evidence log.",
          ),
        );
        store.setStepEvidence(null);
        return;
      }
      store.setStepEvidenceError("");
      const payload = await readSuccessPayload(response);
      store.setStepEvidence((toObjectPayload(payload) as StepEvidencePayload | null) ?? null);
    },
    [apiFetch, buildHeaders, formatActionableError, store, toObjectPayload],
  );

  const fetchEvidenceTimeline = useCallback(async () => {
    const response = await apiFetch("/api/command-tower/evidence-timeline", {
      headers: buildHeaders(),
    });
    if (!response.ok) {
      store.setEvidenceTimelineError(
        formatActionableError(
          formatApiError("Loading the evidence timeline failed", await readErrorDetail(response)),
          "Confirm that a replay has run, then refresh the timeline again.",
          "Inspect the Flow Workshop evidence area and the backend evidence timeline log.",
        ),
      );
      store.setEvidenceTimeline([]);
      return;
    }
    const payload = toObjectPayload(await readSuccessPayload(response));
    store.setEvidenceTimelineError("");
    const items = Array.isArray(payload?.items) ? payload.items : [];
    store.setEvidenceTimeline(items as EvidenceTimelinePayload["items"]);
  }, [apiFetch, buildHeaders, formatActionableError, store, toObjectPayload]);

  const fetchStudioData = useCallback(async () => {
    const [flowResp, templateResp, runResp] = await Promise.all([
      apiFetch("/api/flows?limit=100", { headers: buildHeaders() }),
      apiFetch("/api/templates?limit=100", { headers: buildHeaders() }),
      apiFetch("/api/runs?limit=100", { headers: buildHeaders() }),
    ]);
    const flowMissing = isStudioEmptyBootstrapResponse(flowResp);
    const templateMissing = isStudioEmptyBootstrapResponse(templateResp);
    const runMissing = isStudioEmptyBootstrapResponse(runResp);

    if (!flowMissing) {
      await assertResponseOk(flowResp, "Universal Studio data loading failed");
    }
    if (!templateMissing) {
      await assertResponseOk(templateResp, "Universal Studio data loading failed");
    }
    if (!runMissing) {
      await assertResponseOk(runResp, "Universal Studio data loading failed");
    }

    const flowPayload = flowMissing ? null : toObjectPayload(await readSuccessPayload(flowResp));
    const templatePayload = templateMissing
      ? null
      : toObjectPayload(await readSuccessPayload(templateResp));
    const runPayload = runMissing ? null : toObjectPayload(await readSuccessPayload(runResp));
    const flows = Array.isArray(flowPayload?.flows) ? (flowPayload.flows as UniversalFlow[]) : [];
    const templates = Array.isArray(templatePayload?.templates)
      ? (templatePayload.templates as UniversalTemplate[])
      : [];
    const runs = Array.isArray(runPayload?.runs) ? (runPayload.runs as UniversalRun[]) : [];
    store.setStudioFlows(flows);
    store.setStudioTemplates(templates);
    store.setStudioTemplateHistory([]);
    store.setStudioRuns(runs);
    store.setStudioError("");
    store.setSelectedStudioFlowId((prev) => prev || flows[0]?.flow_id || "");
    store.setSelectedStudioTemplateId((prev) => prev || templates[0]?.template_id || "");
    store.setSelectedStudioRunId((prev) => prev || runs[0]?.run_id || "");
  }, [apiFetch, assertResponseOk, buildHeaders, store, toObjectPayload]);

  const fetchTemplateHistory = useCallback(
    async (templateId: string) => {
      const trimmed = templateId.trim();
      if (!trimmed) {
        store.setStudioTemplateHistory([]);
        return;
      }
      const payload = await requestJson<{ templates: UniversalTemplate[] }>(
        `/api/templates/${encodeURIComponent(trimmed)}/history`,
        "Loading template history failed",
        {
          headers: buildHeaders(),
        },
      );
      store.setStudioTemplateHistory(payload.templates ?? []);
    },
    [buildHeaders, requestJson, store],
  );

  const resolveProfile = useCallback(async () => {
    const payload = await runAction<ProfileResolvePayload>(
      "Profile resolution failed",
      (formatted) => {
        store.setReconstructionError(formatted);
        store.pushNotice("error", formatted);
      },
      async () =>
        requestJson<ProfileResolvePayload>("/api/profiles/resolve", "Profile resolution failed", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...buildHeaders() },
          body: JSON.stringify({
            artifacts: store.reconstructionArtifacts,
            extractor_strategy: store.reconstructionStrategy,
          }),
        }),
    );
    if (!payload) {
      return;
    }
    store.setProfileResolved(payload);
    store.setReconstructionError("");
  }, [buildHeaders, requestJson, runAction, store]);

  const previewReconstruction = useCallback(async () => {
    const payload = await runAction<ReconstructionPreviewPayload>(
      "Reconstruction preview failed",
      (formatted) => {
        store.setReconstructionError(formatted);
        store.pushNotice("error", formatted);
      },
      async () =>
        requestJson<ReconstructionPreviewPayload>("/api/reconstruction/preview", "Reconstruction preview failed", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...buildHeaders() },
          body: JSON.stringify({
            artifacts: store.reconstructionArtifacts,
            video_analysis_mode: store.reconstructionMode,
            extractor_strategy: store.reconstructionStrategy,
            auto_refine_iterations: 3,
          }),
        }),
    );
    if (!payload) {
      return;
    }
    store.setReconstructionPreview(payload);
    store.setReconstructionGenerated(null);
    store.setReconstructionError("");
  }, [buildHeaders, requestJson, runAction, store]);

  const generateReconstruction = useCallback(async () => {
    const payload = await runAction<ReconstructionGeneratePayload>(
      "Reconstruction generation failed",
      (formatted) => {
        store.setReconstructionError(formatted);
        store.pushNotice("error", formatted);
      },
      async () => {
        const preview = store.reconstructionPreview;
        if (!preview) {
          throw new Error("Run Preview before generating reconstruction output.");
        }
        return requestJson<ReconstructionGeneratePayload>(
          "/api/reconstruction/generate",
          "Reconstruction generation failed",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...buildHeaders() },
            body: JSON.stringify({
              preview_id: preview.preview_id,
              template_name: store.studioTemplateName || "reconstructed-template",
              create_run: false,
              run_params: {},
            }),
          },
        );
      },
    );
    if (!payload) {
      return;
    }
    store.setReconstructionGenerated(payload);
    store.setReconstructionError("");
    await fetchStudioData();
  }, [buildHeaders, fetchStudioData, requestJson, runAction, store]);

  const orchestrateFromArtifacts = useCallback(async () => {
    try {
      await requestJson<unknown>("/api/command-tower/orchestrate-from-artifacts", "Artifact orchestration failed", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildHeaders() },
        body: JSON.stringify({
          artifacts: store.reconstructionArtifacts,
          video_analysis_mode: store.reconstructionMode,
          extractor_strategy: store.reconstructionStrategy,
          auto_refine_iterations: 3,
          template_name: store.studioTemplateName || "reconstructed-template",
          create_run: false,
          run_params: {},
        }),
      });
      store.pushNotice("success", "Artifact orchestration completed");
      await fetchStudioData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Artifact orchestration failed";
      const formatted = formatActionableError(message);
      store.setReconstructionError(formatted);
      store.pushNotice("error", formatted);
    }
  }, [buildHeaders, fetchStudioData, formatActionableError, requestJson, store]);

  // ---- Actions ----
  const runCommand = useCallback(
    async (command: Command) => {
      store.setSubmittingId(command.command_id);
      store.setActionState("idle");
      store.addLog("info", `Preparing command ${command.command_id}`, command.command_id);
      try {
        const params: Record<string, string> = {
          BASE_URL: store.params.baseUrl,
          START_URL: store.params.startUrl,
          SUCCESS_SELECTOR: store.params.successSelector,
          HEADLESS: String(store.params.headless),
          MIDSCENE_STRICT: String(store.params.midsceneStrict),
        };
        if (store.params.modelName.trim()) {
          params.MIDSCENE_MODEL_NAME = store.params.modelName.trim();
        }
        if (store.params.registerPassword.trim()) {
          params.REGISTER_PASSWORD = store.params.registerPassword.trim();
        }
        const payload = await requestJson<{ task: Task }>("/api/automation/run", "Command execution failed", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...buildHeaders() },
          body: JSON.stringify({ command: command.command_id, params }),
        });
        store.setSelectedTaskId(payload.task.task_id);
        store.setActionState("success");
        store.setFeedbackText(`Submitted: ${command.title} (task ID: ${payload.task.task_id})`);
        store.addLog("success", `Command submitted successfully, task ${payload.task.task_id}`, command.command_id);
        store.pushNotice("success", `Submitted ${command.title}`);
        store.setParams((p) => ({ ...p, registerPassword: "" }));
        const refreshResults = await Promise.allSettled([
          fetchTasks(),
          fetchDiagnostics(),
          fetchAlerts(),
          fetchLatestFlow(),
          fetchLatestFlowDraft(),
        ]);
        const failedRefreshCount = refreshResults.filter(
          (result) => result.status === "rejected",
        ).length;
        if (failedRefreshCount > 0) {
          const warning = `Command submitted, but ${failedRefreshCount} panel refreshes failed`;
          store.addLog("warn", warning, command.command_id);
          store.pushNotice("warn", `${warning}. Try again in a moment.`);
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Command execution failed";
        const formatted = formatActionableError(message);
        store.setActionState("error");
        store.setFeedbackText(formatted);
        store.addLog("error", formatted, command.command_id);
        store.pushNotice("error", formatted);
        return false;
      } finally {
        store.setSubmittingId("");
      }
    },
    [
      store,
      buildHeaders,
      fetchTasks,
      fetchDiagnostics,
      fetchAlerts,
      fetchLatestFlow,
      fetchLatestFlowDraft,
      formatActionableError,
      requestJson,
    ],
  );

  const cancelTask = useCallback(
    async (task: Task) => {
      try {
        const safeTaskId = encodeURIComponent(task.task_id);
        await requestJson<unknown>(`/api/automation/tasks/${safeTaskId}/cancel`, "Cancel failed", {
          method: "POST",
          headers: buildHeaders(),
        });
        store.setFeedbackText(`Cancelled task ${task.task_id}`);
        store.addLog("warn", `Task cancelled ${task.task_id}`, task.command_id);
        store.pushNotice("warn", `Cancelled task ${task.task_id.slice(0, 8)}`);
        await Promise.all([
          fetchTasks(),
          fetchDiagnostics(),
          fetchAlerts(),
          fetchLatestFlow(),
          fetchLatestFlowDraft(),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Cancel task failed";
        const formatted = formatActionableError(message);
        store.setFeedbackText(formatted);
        store.setActionState("error");
        store.addLog("error", formatted, task.command_id);
        store.pushNotice("error", formatted);
      }
    },
    [
      store,
      buildHeaders,
      fetchTasks,
      fetchDiagnostics,
      fetchAlerts,
      fetchLatestFlow,
      fetchLatestFlowDraft,
      formatActionableError,
      requestJson,
    ],
  );

  const saveFlowDraft = useCallback(async () => {
    try {
      if (!store.flowDraft) {
        throw new Error("Flow draft is empty.");
      }
      await requestJson<unknown>("/api/command-tower/latest-flow-draft", "Saving the flow draft failed", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...buildHeaders() },
        body: JSON.stringify({ flow: store.flowDraft }),
      });
      store.addLog("success", "Flow draft saved successfully");
      store.pushNotice("success", "Flow draft saved successfully");
      await Promise.all([fetchLatestFlow(), fetchLatestFlowDraft(), fetchEvidenceTimeline()]);
      if (store.selectedStepId) {
        await fetchStepEvidence(store.selectedStepId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Saving the flow draft failed";
      const formatted = formatActionableError(message);
      store.addLog("error", formatted);
      store.pushNotice("error", formatted);
    }
  }, [
    store,
    buildHeaders,
    fetchLatestFlow,
    fetchLatestFlowDraft,
    fetchEvidenceTimeline,
    fetchStepEvidence,
    formatActionableError,
    requestJson,
  ]);

  const replayLatestFlow = useCallback(async () => {
    try {
      const payload = await requestJson<{ task: Task }>(
        "/api/command-tower/replay-latest",
        "Replay trigger failed",
        {
          method: "POST",
          headers: buildHeaders(),
        },
      );
      store.setSelectedTaskId(payload.task.task_id);
      store.addLog("success", `Triggered replay task ${payload.task.task_id}`, payload.task.command_id);
      store.pushNotice("success", "Flow replay triggered");
      await Promise.all([fetchTasks(), fetchDiagnostics(), fetchAlerts(), fetchEvidenceTimeline()]);
      if (store.selectedStepId) {
        await fetchStepEvidence(store.selectedStepId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Replay trigger failed";
      const formatted = formatActionableError(message);
      store.addLog("error", formatted);
      store.pushNotice("error", formatted);
    }
  }, [
    store,
    buildHeaders,
    fetchTasks,
    fetchDiagnostics,
    fetchAlerts,
    fetchEvidenceTimeline,
    fetchStepEvidence,
    formatActionableError,
    requestJson,
  ]);

  const replayStep = useCallback(
    async (stepId: string) => {
      try {
        const payload = await requestJson<{ task: Task }>(
          "/api/command-tower/replay-latest-step",
          "Single-step replay trigger failed",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...buildHeaders() },
            body: JSON.stringify({ step_id: stepId }),
          },
        );
        store.setSelectedTaskId(payload.task.task_id);
        store.setSelectedStepId(stepId);
        store.addLog(
          "success",
          `Triggered single-step replay ${stepId} -> ${payload.task.task_id}`,
          payload.task.command_id,
        );
        store.pushNotice("success", `Single-step replay triggered for ${stepId}`);
        await Promise.all([
          fetchTasks(),
          fetchDiagnostics(),
          fetchAlerts(),
          fetchEvidenceTimeline(),
        ]);
        await fetchStepEvidence(stepId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Single-step replay trigger failed";
        const formatted = formatActionableError(message);
        store.addLog("error", formatted);
        store.pushNotice("error", formatted);
      }
    },
    [
      store,
      buildHeaders,
      fetchTasks,
      fetchDiagnostics,
      fetchAlerts,
      fetchEvidenceTimeline,
      fetchStepEvidence,
      formatActionableError,
      requestJson,
    ],
  );

  const replayFromStep = useCallback(
    async (stepId: string) => {
      try {
        const payload = await requestJson<{ task: Task }>(
          "/api/command-tower/replay-latest-from-step",
          "Resume-from-step trigger failed",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...buildHeaders() },
            body: JSON.stringify({
              step_id: stepId,
              replay_preconditions: store.resumeWithPreconditions,
            }),
          },
        );
        store.setSelectedTaskId(payload.task.task_id);
        store.setSelectedStepId(stepId);
        store.addLog(
          "success",
          `Triggered resume from step ${stepId} -> ${payload.task.task_id}`,
          payload.task.command_id,
        );
        store.pushNotice("success", `Resume triggered from step ${stepId}`);
        await Promise.all([
          fetchTasks(),
          fetchDiagnostics(),
          fetchAlerts(),
          fetchEvidenceTimeline(),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Resume-from-step trigger failed";
        const formatted = formatActionableError(message);
        store.addLog("error", formatted);
        store.pushNotice("error", formatted);
      }
    },
    [
      store,
      buildHeaders,
      fetchTasks,
      fetchDiagnostics,
      fetchAlerts,
      fetchEvidenceTimeline,
      formatActionableError,
      requestJson,
    ],
  );

  const buildStudioSchemaPayload = useCallback(() => {
    return store.studioSchemaRows
      .map((row) => (row.key.trim() ? row : null))
      .filter((row): row is StudioSchemaRow => Boolean(row))
      .map((row) => ({
        key: row.key.trim(),
        type: row.type,
        required: row.required,
        description: row.description.trim() || null,
        enum_values:
          row.type === "enum"
            ? row.enum_values
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean)
            : [],
        pattern: row.type === "regex" ? row.pattern.trim() || null : null,
      }));
  }, [store.studioSchemaRows]);

  const importLatestFlow = useCallback(async () => {
    const result = await runAction<unknown>(
      "Importing the latest Flow failed",
      (formatted) => {
        store.setStudioError(formatted);
        store.pushNotice("error", formatted);
      },
      async () =>
        requestJson<unknown>("/api/flows/import-latest", "Importing the latest Flow failed", {
          method: "POST",
          headers: buildHeaders(),
        }),
    );
    if (result === null) {
      return;
    }
    store.pushNotice("success", "Imported the latest Flow");
    await fetchStudioData();
  }, [buildHeaders, fetchStudioData, requestJson, runAction, store]);

  const createTemplate = useCallback(async () => {
    try {
      const schema = buildStudioSchemaPayload();
      const defaults = { ...store.studioDefaults };
      const policies = {
        retries: store.studioPolicies.retries,
        timeout_seconds: store.studioPolicies.timeout_seconds,
        otp: {
          required: store.studioPolicies.otp.required,
          provider: store.studioPolicies.otp.provider,
          timeout_seconds: store.studioPolicies.otp.timeout_seconds,
          regex: store.studioPolicies.otp.regex,
          sender_filter: store.studioPolicies.otp.sender_filter || null,
          subject_filter: store.studioPolicies.otp.subject_filter || null,
        },
        branches: {},
      };
      const flowId = store.selectedStudioFlowId || store.flowDraft?.flow_id || "";
      if (!flowId) {
        throw new Error("Select a Flow before creating a template.");
      }
      await requestJson<unknown>("/api/templates", "Creating the template failed", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildHeaders() },
        body: JSON.stringify({
          flow_id: flowId,
          name: store.studioTemplateName,
          params_schema: schema,
          defaults,
          policies,
        }),
      });
      store.pushNotice("success", "Template created successfully");
      await fetchStudioData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Creating the template failed";
      const formatted = formatActionableError(message);
      store.setStudioError(formatted);
      store.pushNotice("error", formatted);
    }
  }, [
    store,
    buildHeaders,
    buildStudioSchemaPayload,
    fetchStudioData,
    formatActionableError,
    requestJson,
  ]);

  const updateTemplate = useCallback(async () => {
    try {
      if (!store.selectedStudioTemplateId) {
        throw new Error("Select a template before updating it.");
      }
      const schema = buildStudioSchemaPayload();
      const defaults = { ...store.studioDefaults };
      const policies = {
        retries: store.studioPolicies.retries,
        timeout_seconds: store.studioPolicies.timeout_seconds,
        otp: {
          required: store.studioPolicies.otp.required,
          provider: store.studioPolicies.otp.provider,
          timeout_seconds: store.studioPolicies.otp.timeout_seconds,
          regex: store.studioPolicies.otp.regex,
          sender_filter: store.studioPolicies.otp.sender_filter || null,
          subject_filter: store.studioPolicies.otp.subject_filter || null,
        },
        branches: {},
      };
      await requestJson<unknown>(
        `/api/templates/${encodeURIComponent(store.selectedStudioTemplateId)}`,
        "Updating the template failed",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...buildHeaders() },
          body: JSON.stringify({
            name: store.studioTemplateName,
            params_schema: schema,
            defaults,
            policies,
          }),
        },
      );
      store.pushNotice("success", "Template updated successfully");
      await fetchStudioData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Updating the template failed";
      const formatted = formatActionableError(message);
      store.setStudioError(formatted);
      store.pushNotice("error", formatted);
    }
  }, [
    store,
    buildHeaders,
    buildStudioSchemaPayload,
    fetchStudioData,
    formatActionableError,
    requestJson,
  ]);

  const promoteTemplate = useCallback(async () => {
    try {
      const flowId = store.flowDraft?.flow_id || store.selectedStudioFlowId;
      if (!flowId) {
        throw new Error("Save or import a Flow before promoting a template.");
      }
      await requestJson<unknown>("/api/templates/promote", "Promoting the template failed", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildHeaders() },
        body: JSON.stringify({
          flow_id: flowId,
          template_name: store.studioTemplateName || "promoted-template",
          change_note: "promoted from Flow Workshop",
          recommended: false,
        }),
      });
      store.pushNotice("success", "Template promoted successfully");
      await fetchStudioData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Promoting the template failed";
      const formatted = formatActionableError(message);
      store.setStudioError(formatted);
      store.pushNotice("error", formatted);
    }
  }, [store, buildHeaders, fetchStudioData, formatActionableError, requestJson]);

  const forkTemplateVersion = useCallback(async () => {
    try {
      if (!store.selectedStudioTemplateId) {
        throw new Error("Select a template before forking a new version.");
      }
      await requestJson<unknown>(
        `/api/templates/${encodeURIComponent(store.selectedStudioTemplateId)}/fork-version`,
        "Forking template version failed",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...buildHeaders() },
          body: JSON.stringify({
            template_name: `${store.studioTemplateName || "template"}-vnext`,
            change_note: "forked from Quick Launch",
          }),
        },
      );
      store.pushNotice("success", "Template version forked successfully");
      await fetchStudioData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Forking template version failed";
      const formatted = formatActionableError(message);
      store.setStudioError(formatted);
      store.pushNotice("error", formatted);
    }
  }, [store, buildHeaders, fetchStudioData, formatActionableError, requestJson]);

  const markTemplateRecommended = useCallback(async () => {
    try {
      if (!store.selectedStudioTemplateId) {
        throw new Error("Select a template before marking it recommended.");
      }
      await requestJson<unknown>(
        `/api/templates/${encodeURIComponent(store.selectedStudioTemplateId)}/mark-recommended`,
        "Marking the template recommended failed",
        {
          method: "POST",
          headers: buildHeaders(),
        },
      );
      store.pushNotice("success", "Recommended template updated");
      await fetchStudioData();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Marking the template recommended failed";
      const formatted = formatActionableError(message);
      store.setStudioError(formatted);
      store.pushNotice("error", formatted);
    }
  }, [store, buildHeaders, fetchStudioData, formatActionableError, requestJson]);

  const createRun = useCallback(async () => {
    try {
      if (!store.selectedStudioTemplateId) {
        throw new Error("Select a template before creating a run.");
      }
      const payload = await requestJson<unknown>("/api/runs", "Creating the run failed", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildHeaders() },
        body: JSON.stringify({
          template_id: store.selectedStudioTemplateId,
          params: { ...store.studioRunParams },
          otp_code: store.studioOtpCode.trim() || undefined,
        }),
      });
      const run = unwrapRunPayload(payload);
      if (run?.run_id) {
        store.setSelectedStudioRunId(run.run_id);
      }
      store.pushNotice("success", "Run created successfully");
      await Promise.all([fetchStudioData(), fetchTasks()]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Creating the run failed";
      const formatted = formatActionableError(message);
      store.setStudioError(formatted);
      store.pushNotice("error", formatted);
      return false;
    }
  }, [
    store,
    buildHeaders,
    fetchStudioData,
    fetchTasks,
    formatActionableError,
    requestJson,
    unwrapRunPayload,
  ]);

  const submitRunOtp = useCallback(
    async (
      runId: string,
      status: UniversalRun["status"],
      waitContext?: UniversalRun["wait_context"],
    ) => {
      try {
        const isProviderProtectedWaitingUser =
          status === "waiting_user" &&
          waitContext?.reason_code === "provider_protected_payment_step";
        const allowedResumeKinds = new Set(waitContext?.allowed_resume_kinds ?? []);
        const requiredActionKinds = new Set(
          (waitContext?.required_actions ?? []).map((item) => item.kind),
        );
        const supportsApproval =
          allowedResumeKinds.has("approval") || requiredActionKinds.has("approval");
        const supportsInput =
          allowedResumeKinds.has("input") || requiredActionKinds.has("input");
        const shouldSubmitApproval =
          isProviderProtectedWaitingUser ||
          (status === "waiting_user" && supportsApproval && !supportsInput);
        const inputLabel =
          status === "waiting_otp"
            ? "OTP"
            : shouldSubmitApproval
              ? "continue action"
              : "supplemental input";
        const normalizedOtpCode = store.studioOtpCode.trim();
        if (!normalizedOtpCode && !shouldSubmitApproval) {
          throw new Error(`Provide ${inputLabel} before continuing.`);
        }
        const payload = await requestJson<unknown>(
          `/api/runs/${encodeURIComponent(runId)}/resume`,
          `Submitting ${inputLabel} failed`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...buildHeaders() },
            body: JSON.stringify({
              kind:
                status === "waiting_otp"
                  ? "otp"
                  : shouldSubmitApproval
                    ? "approval"
                    : "input",
              otp_code: status === "waiting_otp" ? normalizedOtpCode || "" : undefined,
              input_text:
                status === "waiting_user" && !shouldSubmitApproval
                  ? normalizedOtpCode || ""
                  : undefined,
              approved: shouldSubmitApproval ? true : undefined,
              confirmation_note:
                shouldSubmitApproval && normalizedOtpCode ? normalizedOtpCode : undefined,
            }),
          },
        );
        const run = unwrapRunPayload(payload);
        if (run?.run_id) {
          store.setSelectedStudioRunId(run.run_id);
        }
        store.pushNotice("success", `${inputLabel} submitted, run resumed`);
        await Promise.all([fetchStudioData(), fetchTasks()]);
      } catch (error) {
        const isProviderProtectedWaitingUser =
          status === "waiting_user" &&
          waitContext?.reason_code === "provider_protected_payment_step";
        const allowedResumeKinds = new Set(waitContext?.allowed_resume_kinds ?? []);
        const requiredActionKinds = new Set(
          (waitContext?.required_actions ?? []).map((item) => item.kind),
        );
        const supportsApproval =
          allowedResumeKinds.has("approval") || requiredActionKinds.has("approval");
        const supportsInput =
          allowedResumeKinds.has("input") || requiredActionKinds.has("input");
        const shouldSubmitApproval =
          isProviderProtectedWaitingUser ||
          (status === "waiting_user" && supportsApproval && !supportsInput);
        const inputLabel =
          status === "waiting_otp"
            ? "OTP"
            : shouldSubmitApproval
              ? "continue action"
              : "supplemental input";
        const message = error instanceof Error ? error.message : `Submitting ${inputLabel} failed`;
        const formatted = formatActionableError(message);
        store.setStudioError(formatted);
        store.pushNotice("error", formatted);
      }
    },
    [
      store,
      buildHeaders,
      fetchStudioData,
      fetchTasks,
      formatActionableError,
      requestJson,
      unwrapRunPayload,
    ],
  );

  const refreshDiagnostics = useCallback(() => {
    void Promise.all([
      fetchDiagnostics(),
      fetchAlerts(),
      fetchLatestFlow(),
      fetchLatestFlowDraft(),
      fetchEvidenceTimeline(),
    ]);
    if (store.selectedStepId) {
      void fetchStepEvidence(store.selectedStepId);
    }
  }, [
    fetchAlerts,
    fetchDiagnostics,
    fetchEvidenceTimeline,
    fetchLatestFlow,
    fetchLatestFlowDraft,
    fetchStepEvidence,
    store.selectedStepId,
  ]);

  const refreshStudio = useCallback(() => {
    void fetchStudioData().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Universal Studio refresh failed";
      store.setStudioError(formatActionableError(message));
    });
  }, [fetchStudioData, formatActionableError, store]);

  const refreshTasks = useCallback(() => {
    void fetchTasks();
    void fetchStudioData().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Universal Studio refresh failed";
      store.setStudioError(formatActionableError(message));
    });
  }, [fetchStudioData, fetchTasks, formatActionableError, store]);

  return {
    buildHeaders,
    fetchCommands,
    fetchTasks,
    fetchDiagnostics,
    fetchAlerts,
    fetchLatestFlow,
    fetchLatestFlowDraft,
    fetchStepEvidence,
    fetchEvidenceTimeline,
    fetchStudioData,
    fetchTemplateHistory,
    resolveProfile,
    previewReconstruction,
    generateReconstruction,
    orchestrateFromArtifacts,
    runCommand,
    cancelTask,
    saveFlowDraft,
    replayLatestFlow,
    replayStep,
    replayFromStep,
    importLatestFlow,
    createTemplate,
    updateTemplate,
    promoteTemplate,
    forkTemplateVersion,
    markTemplateRecommended,
    createRun,
    submitRunOtp,
    refreshDiagnostics,
    refreshStudio,
    refreshTasks,
  };
}
