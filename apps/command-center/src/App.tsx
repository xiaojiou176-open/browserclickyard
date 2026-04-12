import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "./components/ConfirmDialog";
import ConsoleHeader from "./components/ConsoleHeader";
import HelpPanel from "./components/HelpPanel";
import OnboardingTour from "./components/OnboardingTour";
import ToastStack from "./components/ToastStack";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui";
import { useApiClient } from "./hooks/useApiClient";
import { useAppStore } from "./hooks/useAppStore";
import { usePolling } from "./hooks/usePolling";
import { pickUiText, type UiLocale } from "./i18n/uiLocale";
import type { Command, Task } from "./types";
import { isDangerous } from "./utils/commands";
import QuickLaunchView from "./views/QuickLaunchView";

const TaskCenterView = lazy(() => import("./views/TaskCenterView"));
const FlowWorkshopView = lazy(() => import("./views/FlowWorkshopView"));
const ReviewBoardView = lazy(() => import("./views/ReviewBoardView"));

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

function ViewLoadingFallback({ locale }: { locale: UiLocale }) {
  return (
    <Card className="loading-card view-loading-fallback" role="status" aria-live="polite">
      <CardContent>
        <div className="spinner" />
        {pickUiText(locale, "Loading page...", "\u6b63\u5728\u52a0\u8f7d\u9875\u9762...")}
      </CardContent>
    </Card>
  );
}

export default function App() {
  const store = useAppStore();
  const api = useApiClient(store);
  const routePath =
    typeof window !== "undefined" ? window.location.pathname.replace(/\/+$/, "") || "/" : "/";
  const isRegisterRoute = routePath === "/register";
  const lastEvidenceStepRef = useRef("");
  const lastAuthSignatureRef = useRef("");
  const {
    isFirstUseActive,
    firstUseStage,
    setFirstUseStage,
    firstUseProgress,
    canCompleteFirstUse,
    markFirstUseRunTriggered,
    markFirstUseResultSeen,
    completeFirstUse,
    selectedStudioTemplateId,
    studioTemplates,
    selectedStepId,
    setCommandState,
    setTaskState,
    setFeedbackText,
    addLog,
    pushNotice,
    setStudioTemplateName,
    setStudioSchemaRows,
    setStudioDefaults,
    setStudioPolicies,
    setStudioRunParams,
    setSelectedStudioFlowId,
    setStepEvidence,
    setStepEvidenceError,
    setConfirmDialog,
  } = store;
  const shouldShowOnboarding = store.showOnboarding;
  const [navDirection, setNavDirection] = useState<"forward" | "backward">("forward");
  const [feedbackTone, setFeedbackTone] = useState<"success" | "warn" | "error" | null>(null);
  const previousViewRef = useRef(store.activeView);
  const previousNoticeIdRef = useRef("");
  const {
    fetchCommands,
    fetchTasks,
    fetchDiagnostics,
    fetchAlerts,
    fetchLatestFlow,
    fetchLatestFlowDraft,
    fetchEvidenceTimeline,
    fetchStudioData,
    fetchTemplateHistory,
    fetchStepEvidence,
    runCommand,
    forkTemplateVersion,
    markTemplateRecommended,
    promoteTemplate,
    createRun,
    cancelTask,
  } = api;

  // Bootstrap
  const bootstrap = useCallback(async () => {
    try {
      setCommandState("loading");
      setTaskState("loading");
      await Promise.all([
        fetchCommands(),
        fetchTasks(),
        fetchDiagnostics(),
        fetchAlerts(),
        fetchLatestFlow(),
        fetchLatestFlowDraft(),
      ]);
      await fetchEvidenceTimeline();
      await fetchStudioData();
      setFeedbackText(pickUiText(store.uiLocale, "System ready", "\u7cfb\u7edf\u5df2\u5c31\u7eea"));
      addLog(
        "success",
        pickUiText(
          store.uiLocale,
          "System initialization completed",
          "\u7cfb\u7edf\u521d\u59cb\u5316\u5df2\u5b8c\u6210",
        ),
      );
      pushNotice(
        "success",
        pickUiText(
          store.uiLocale,
          `System ready. ${RECOMMENDED_FIRST_PATH}`,
          `\u7cfb\u7edf\u5df2\u5c31\u7eea\u3002\u63a8\u8350\u8def\u5f84\uff1a\u5148\u586b URL\uff0c\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u542f\u52a8\u5b9e\u9a8c\uff0c\u518d\u8bfb\u6700\u65b0\u7ed3\u679c\uff0c\u6700\u540e\u624d\u6253\u5f00 Advanced Review\u3002`,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : pickUiText(store.uiLocale, "Unknown error", "\u672a\u77e5\u9519\u8bef");
      setCommandState("error");
      setTaskState("error");
      setFeedbackText(message);
      addLog("error", message);
      pushNotice("error", message);
    }
  }, [
    addLog,
    fetchAlerts,
    fetchCommands,
    fetchDiagnostics,
    fetchEvidenceTimeline,
    fetchLatestFlow,
    fetchLatestFlowDraft,
    fetchStudioData,
    fetchTasks,
    pushNotice,
    setCommandState,
    setFeedbackText,
    setTaskState,
    store.uiLocale,
  ]);

  usePolling(store, bootstrap, fetchTasks);

  useEffect(() => {
    const token = store.params.automationToken.trim();
    const clientId = store.params.automationClientId.trim();
    const signature = `${token}::${clientId}`;
    if (!token) {
      lastAuthSignatureRef.current = "";
      return;
    }
    if (lastAuthSignatureRef.current === signature) {
      return;
    }
    lastAuthSignatureRef.current = signature;
    void Promise.all([
      fetchCommands(),
      fetchTasks(),
      fetchDiagnostics(),
      fetchAlerts(),
      fetchLatestFlow(),
      fetchLatestFlowDraft(),
      fetchEvidenceTimeline(),
      fetchStudioData(),
    ]).catch(() => undefined);
  }, [
    fetchAlerts,
    fetchCommands,
    fetchDiagnostics,
    fetchEvidenceTimeline,
    fetchLatestFlow,
    fetchLatestFlowDraft,
    fetchStudioData,
    fetchTasks,
    store.params.automationClientId,
    store.params.automationToken,
  ]);

  // Sync selected template -> form data
  useEffect(() => {
    if (!selectedStudioTemplateId) {
      return;
    }
    const target = studioTemplates.find((item) => item.template_id === selectedStudioTemplateId);
    if (!target) {
      return;
    }
    setStudioTemplateName(target.name);
    setStudioSchemaRows(
      target.params_schema.map((item) => ({
        key: item.key ?? "",
        type: item.type ?? "string",
        required: Boolean(item.required),
        description: item.description ?? "",
        enum_values: (item.enum_values ?? []).join(","),
        pattern: item.pattern ?? "",
      })),
    );
    setStudioDefaults(target.defaults ?? {});
    setStudioPolicies({
      retries: target.policies?.retries ?? 0,
      timeout_seconds: target.policies?.timeout_seconds ?? 120,
      otp: {
        required: target.policies?.otp?.required ?? false,
        provider: target.policies?.otp?.provider ?? "manual",
        timeout_seconds: target.policies?.otp?.timeout_seconds ?? 120,
        regex: target.policies?.otp?.regex ?? "\\b(\\d{6})\\b",
        sender_filter: target.policies?.otp?.sender_filter ?? "",
        subject_filter: target.policies?.otp?.subject_filter ?? "",
      },
    });
    setStudioRunParams(target.defaults ?? {});
    setSelectedStudioFlowId(target.flow_id);
  }, [
    selectedStudioTemplateId,
    setSelectedStudioFlowId,
    setStudioDefaults,
    setStudioPolicies,
    setStudioRunParams,
    setStudioSchemaRows,
    setStudioTemplateName,
    studioTemplates,
  ]);

  useEffect(() => {
    const templateId = selectedStudioTemplateId.trim();
    if (!templateId) {
      store.setStudioTemplateHistory([]);
      return;
    }
    void fetchTemplateHistory(templateId).catch(() => undefined);
  }, [fetchTemplateHistory, selectedStudioTemplateId, store]);

  // Fetch step evidence on selection
  useEffect(() => {
    const stepId = selectedStepId.trim();
    if (!stepId) {
      lastEvidenceStepRef.current = "";
      setStepEvidence(null);
      setStepEvidenceError("");
      return;
    }
    if (lastEvidenceStepRef.current === stepId) {
      return;
    }
    lastEvidenceStepRef.current = stepId;
    void fetchStepEvidence(stepId);
  }, [fetchStepEvidence, selectedStepId, setStepEvidence, setStepEvidenceError]);

  // --- Handlers ---
  const handleRunCommand = useCallback(
    async (command: Command) => {
      if (isDangerous(command)) {
        setConfirmDialog({
          title: pickUiText(
            store.uiLocale,
            "Confirm dangerous command",
            "\u786e\u8ba4\u5371\u9669\u547d\u4ee4",
          ),
          message: pickUiText(
            store.uiLocale,
            `The command "${command.title}" may modify or delete files. Do you want to continue?`,
            `\u547d\u4ee4\u201c${command.title}\u201d\u53ef\u80fd\u4f1a\u4fee\u6539\u6216\u5220\u9664\u6587\u4ef6\u3002\u4f60\u8981\u7ee7\u7eed\u5417\uff1f`,
          ),
          onConfirm: () => {
            setConfirmDialog(null);
            void (async () => {
              const success = await runCommand(command);
              if (!success || !isFirstUseActive) {
                return;
              }
              markFirstUseRunTriggered();
              store.setActiveView("tasks");
            })();
          },
        });
        return;
      }
      const success = await runCommand(command);
      if (!success || !isFirstUseActive) {
        return;
      }
      markFirstUseRunTriggered();
      store.setActiveView("tasks");
    },
    [isFirstUseActive, markFirstUseRunTriggered, runCommand, setConfirmDialog, store],
  );

  const handleCancelTask = useCallback((task: Task) => void cancelTask(task), [cancelTask]);
  const handleCreateRun = useCallback(async () => {
    const created = await createRun();
    if (!created) {
      return;
    }
    if (isFirstUseActive) {
      markFirstUseRunTriggered();
      store.setActiveView("tasks");
    }
  }, [createRun, isFirstUseActive, markFirstUseRunTriggered, store]);

  const handleGoToLaunch = useCallback(() => store.setActiveView("launch"), [store]);
  const handleRestartOnboarding = useCallback(() => {
    store.setActiveView("launch");
    store.restartOnboarding();
  }, [store]);

  useEffect(() => {
    if (!isFirstUseActive) {
      return;
    }
    const hasOutcome =
      store.tasks.some((task) => task.status === "success" || task.status === "failed") ||
      store.studioRuns.some((run) => run.status === "success" || run.status === "failed");
    if (hasOutcome) {
      markFirstUseResultSeen();
    }
  }, [isFirstUseActive, markFirstUseResultSeen, store.studioRuns, store.tasks]);

  useEffect(() => {
    const order = { launch: 0, tasks: 1, workshop: 2, review: 3 } as const;
    const prev = previousViewRef.current;
    if (prev !== store.activeView) {
      setNavDirection(order[store.activeView] >= order[prev] ? "forward" : "backward");
      previousViewRef.current = store.activeView;
    }
  }, [store.activeView]);

  useEffect(() => {
    const latest = store.notices[store.notices.length - 1];
    if (!latest || latest.id === previousNoticeIdRef.current) {
      return;
    }
    previousNoticeIdRef.current = latest.id;
    setFeedbackTone(latest.level === "info" ? null : latest.level);
    const timeoutId = window.setTimeout(() => setFeedbackTone(null), 520);
    return () => window.clearTimeout(timeoutId);
  }, [store.notices]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.lang = store.uiLocale;
    document.documentElement.setAttribute("data-uiq-locale", store.uiLocale);
  }, [store.uiLocale]);

  return (
    <div
      className="console-root motion-enter-page"
      data-feedback-tone={feedbackTone ?? undefined}
      data-nav-direction={navDirection}
    >
      <a href="#main-content" className="skip-nav">
        {pickUiText(store.uiLocale, "Skip to main content", "\u8df3\u8fc7\u81f3\u4e3b\u8981\u5185\u5bb9")}
      </a>

      <ToastStack locale={store.uiLocale} notices={store.notices} onDismiss={store.dismissNotice} />

      <OnboardingTour
        active={shouldShowOnboarding}
        locale={store.uiLocale}
        onComplete={store.completeOnboarding}
      />

      <ConsoleHeader
        runningCount={store.runningCount}
        successCount={store.successCount}
        failedCount={store.failedCount}
        activeView={store.activeView}
        locale={store.uiLocale}
        onLocaleChange={store.setUiLocale as (locale: UiLocale) => void}
        onViewChange={store.setActiveView}
        onOpenHelp={() => store.setShowHelp(true)}
        onRestartTour={handleRestartOnboarding}
      />

      {isRegisterRoute && (
        <Card
          className="card-raised"
          aria-label={pickUiText(store.uiLocale, "Registration flow preset", "\u6ce8\u518c\u6d41\u7a0b\u9884\u8bbe")}
        >
          <CardHeader>
            <CardTitle as="h2">
              {pickUiText(store.uiLocale, "Register Scenario", "\u6ce8\u518c\u573a\u666f")}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            {pickUiText(
              store.uiLocale,
              "The /register preset route is active. The page has switched into the registration flow validation context.",
              "/register \u9884\u8bbe\u8def\u7531\u5df2\u542f\u7528\u3002\u9875\u9762\u5df2\u5207\u6362\u5230\u6ce8\u518c\u6d41\u7a0b\u9a8c\u8bc1\u4e0a\u4e0b\u6587\u3002",
            )}
          </CardContent>
        </Card>
      )}

      <main
        className="view-container motion-enter-content"
        id="main-content"
        data-active-view={store.activeView}
      >
        <div
          key={store.activeView}
          className={`view-switch-layer motion-fade-in motion-slide-up view-switch-layer--${navDirection}`}
          data-view={store.activeView}
        >
          {store.activeView === "launch" && (
            <QuickLaunchView
              commands={store.commands}
              commandState={store.commandState}
              activeTab={store.activeTab}
              submittingId={store.submittingId}
              feedbackText={store.feedbackText}
              onActiveTabChange={store.setActiveTab}
              onRunCommand={handleRunCommand}
              locale={store.uiLocale}
              params={store.params}
              onParamsChange={store.handleParamsChange}
              templates={store.studioTemplates}
              templateHistory={store.studioTemplateHistory}
              onCreateRun={handleCreateRun}
              onForkTemplateVersion={forkTemplateVersion}
              onMarkTemplateRecommended={markTemplateRecommended}
              onRunParamsChange={store.setStudioRunParams}
              runParams={store.studioRunParams}
              onSelectedTemplateIdChange={store.setSelectedStudioTemplateId}
              selectedTemplateId={store.selectedStudioTemplateId}
              isFirstUseActive={isFirstUseActive}
              firstUseStage={firstUseStage}
              onFirstUseStageChange={setFirstUseStage}
              firstUseProgress={firstUseProgress}
              canCompleteFirstUse={canCompleteFirstUse}
              onCompleteFirstUse={completeFirstUse}
            />
          )}

          {store.activeView === "tasks" && (
            <Suspense fallback={<ViewLoadingFallback locale={store.uiLocale} />}>
              <TaskCenterView
                tasks={store.tasks}
                taskState={store.taskState}
                selectedTaskId={store.selectedTaskId}
                taskErrorMessage={store.taskErrorMessage}
                onSelectTask={store.setSelectedTaskId}
                onCancelTask={handleCancelTask}
                onRefreshTasks={api.refreshTasks}
                locale={store.uiLocale}
                statusFilter={store.statusFilter}
                onStatusFilterChange={store.setStatusFilter}
                commandFilter={store.commandFilter}
                onCommandFilterChange={store.setCommandFilter}
                taskLimit={store.taskLimit}
                onTaskLimitChange={store.setTaskLimit}
                logs={store.logs}
                selectedTask={store.selectedTask}
                terminalRows={store.terminalRows}
                onTerminalRowsChange={store.setTerminalRows}
                terminalFilter={store.terminalFilter}
                onTerminalFilterChange={store.setTerminalFilter}
                autoScroll={store.autoScroll}
                onAutoScrollChange={store.setAutoScroll}
                onClearLogs={store.clearLogs}
                runs={store.studioRuns}
                selectedRunId={store.selectedStudioRunId}
                onSelectedRunIdChange={store.setSelectedStudioRunId}
                otpCode={store.studioOtpCode}
                onOtpCodeChange={store.setStudioOtpCode}
                onSubmitOtp={api.submitRunOtp}
                onGoToLaunch={handleGoToLaunch}
              />
            </Suspense>
          )}

          {store.activeView === "workshop" && (
            <Suspense fallback={<ViewLoadingFallback locale={store.uiLocale} />}>
              <FlowWorkshopView
                locale={store.uiLocale}
                diagnostics={store.diagnostics}
                alerts={store.alerts}
                diagnosticsError={store.diagnosticsError}
                alertError={store.alertError}
                latestFlow={store.latestFlow}
                flowError={store.flowError}
                flowDraft={store.flowDraft}
                selectedStepId={store.selectedStepId}
                stepEvidence={store.stepEvidence}
                evidenceTimeline={store.evidenceTimeline}
                evidenceTimelineError={store.evidenceTimelineError}
                resumeWithPreconditions={store.resumeWithPreconditions}
                stepEvidenceError={store.stepEvidenceError}
                onFlowDraftChange={store.setFlowDraft}
                onSelectStep={store.setSelectedStepId}
                onResumeWithPreconditionsChange={store.setResumeWithPreconditions}
                onSaveFlowDraft={api.saveFlowDraft}
                onPromoteTemplate={promoteTemplate}
                onReplayLatestFlow={api.replayLatestFlow}
                onReplayStep={api.replayStep}
                onResumeFromStep={api.replayFromStep}
                onRefresh={api.refreshDiagnostics}
              />
            </Suspense>
          )}

          {store.activeView === "review" && (
            <Suspense fallback={<ViewLoadingFallback locale={store.uiLocale} />}>
              <ReviewBoardView
                baseUrl={store.params.baseUrl}
                automationToken={store.params.automationToken}
                automationClientId={store.params.automationClientId}
                locale={store.uiLocale}
                runs={store.studioRuns}
                templates={store.studioTemplates}
              />
            </Suspense>
          )}
        </div>
      </main>

      {store.showHelp && (
        <HelpPanel
          activeView={store.activeView}
          locale={store.uiLocale}
          onClose={() => store.setShowHelp(false)}
          onRestartTour={handleRestartOnboarding}
        />
      )}

      {store.confirmDialog && (
        <ConfirmDialog
          locale={store.uiLocale}
          title={store.confirmDialog.title}
          message={store.confirmDialog.message}
          variant="danger"
          confirmLabel={store.uiLocale === "zh-CN" ? "\u786e\u8ba4" : "Confirm"}
          cancelLabel={store.uiLocale === "zh-CN" ? "\u53d6\u6d88" : "Cancel"}
          onConfirm={store.confirmDialog.onConfirm}
          onCancel={() => store.setConfirmDialog(null)}
        />
      )}
    </div>
  );
}
