import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import DetailFieldRow from "../components/DetailFieldRow";
import EmptyState from "../components/EmptyState";
import ManualGateDesk from "../features/manual-gates/ManualGateDesk";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { formatDateTime } from "../shared/locale";
import LogStream from "../components/LogStream";
import RunDetailCard from "../components/RunDetailCard";
import TaskListPanel from "../components/TaskListPanel";
import TerminalPanel from "../components/TerminalPanel";
import { Badge, Button } from "../components/ui";
import {
  TASK_CENTER_DETAIL_COLUMN_TEST_ID,
  TASK_CENTER_LIST_COLUMN_TEST_ID,
  TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID,
  TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID,
} from "../constants/testIds";
import { formatActionableErrorMessage } from "../shared/errorFormatter";
import type {
  LogEntry,
  LogLevel,
  RunRecordViewHint,
  Task,
  TaskState,
  UniversalRun,
} from "../types";
import { UNIVERSAL_RUN_STATUS_LABEL } from "../types";

interface TaskCenterViewProps {
  tasks: Task[];
  locale?: UiLocale;
  taskState: TaskState;
  selectedTaskId: string;
  taskErrorMessage: string;
  onSelectTask: (taskId: string) => void;
  onCancelTask: (task: Task) => void;
  onRefreshTasks: () => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  commandFilter: string;
  onCommandFilterChange: (value: string) => void;
  taskLimit: number;
  onTaskLimitChange: (value: number) => void;
  // Terminal
  logs: LogEntry[];
  selectedTask: Task | null;
  terminalRows: number;
  onTerminalRowsChange: (rows: number) => void;
  terminalFilter: "all" | LogLevel;
  onTerminalFilterChange: (filter: "all" | LogLevel) => void;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  onClearLogs: () => void;
  // Runs integration
  runs: UniversalRun[];
  selectedRunId: string;
  onSelectedRunIdChange: (id: string) => void;
  otpCode: string;
  onOtpCodeChange: (code: string) => void;
  onSubmitOtp: (
    runId: string,
    status: UniversalRun["status"],
    waitContext?: UniversalRun["wait_context"],
  ) => void;
  onGoToLaunch: () => void;
}

const runRecordDetailHint: RunRecordViewHint = {
  title: "Run details",
  sections: ["lane", "status", "progress", "timeline", "output"],
};
const subTabIds = {
  tasks: "task-center-tab-command-runs",
  runs: "task-center-tab-template-runs",
} as const;

const subPanelIds = {
  tasks: "task-center-panel-command-runs",
  runs: "task-center-panel-template-runs",
} as const;

const subTabOrder: Array<"tasks" | "runs"> = ["tasks", "runs"];
const subTabCount = subTabOrder.length;
const PROVIDER_PROTECTED_PAYMENT_STEP_REASON = "provider_protected_payment_step";
const OTP_DIGITS_PATTERN = /^\d{4,8}$/;
const commandLaneTitle = "Command queue";
const workflowLaneTitle = "Lab runs";
const commandLaneSourceLabel = "Command queue item";
const workflowLaneSourceLabel = "Lab run";
const LAB_LENS_LABELS: Array<{ key: string; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "load", label: "Load" },
  { key: "perf", label: "Perf" },
  { key: "explore", label: "Explore" },
  { key: "chaos", label: "Chaos" },
  { key: "visual", label: "Visual" },
  { key: "a11y", label: "A11y" },
];

const isProviderProtectedPaymentWait = (run: UniversalRun | null): boolean => {
  return (
    run?.status === "waiting_user" &&
    run.wait_context?.reason_code === PROVIDER_PROTECTED_PAYMENT_STEP_REASON
  );
};

const readRunParam = (run: UniversalRun | null, keys: string[]): string | null => {
  if (!run) {
    return null;
  }
  for (const key of keys) {
    const value = run.params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const localizeRunStatus = (locale: UiLocale, status: UniversalRun["status"]): string => {
  const english = UNIVERSAL_RUN_STATUS_LABEL[status];
  const chineseMap: Record<UniversalRun["status"], string> = {
    queued: "\u6392\u961f\u4e2d",
    running: "\u8fd0\u884c\u4e2d",
    waiting_user: "\u7b49\u5f85\u4eba\u5de5\u8f93\u5165",
    waiting_otp: "\u7b49\u5f85 OTP",
    success: "\u5df2\u6210\u529f",
    failed: "\u5df2\u5931\u8d25",
    cancelled: "\u5df2\u53d6\u6d88",
  };
  return pickUiText(locale, english, chineseMap[status]);
};

const getRunRecordDetailHintText = (locale: UiLocale): string =>
  pickUiText(
    locale,
    `${runRecordDetailHint.title}: lane / status / progress / timeline / output`,
    "\u8fd0\u884c\u8be6\u60c5\uff1a\u961f\u5217 / \u72b6\u6001 / \u8fdb\u5ea6 / \u65f6\u95f4\u7ebf / \u8f93\u51fa",
  );

const getLabTarget = (run: UniversalRun | null, locale: UiLocale): string => {
  return (
    readRunParam(run, ["START_URL", "startUrl", "BASE_URL", "baseUrl"]) ??
    pickUiText(locale, "Localhost-first target", "\u4f18\u5148 localhost \u76ee\u6807")
  );
};

const getLabLensLabels = (run: UniversalRun | null, locale: UiLocale): string[] => {
  if (!run) {
    return [];
  }
  const labelMap = Object.fromEntries(
    LAB_LENS_LABELS.map(({ key, label }) => [
      key,
      pickUiText(
        locale,
        label,
        {
          Summary: "\u603b\u7ed3",
          Load: "\u8d1f\u8f7d",
          Perf: "\u6027\u80fd",
          Explore: "\u63a2\u7d22",
          Chaos: "\u6df7\u6c8c",
          Visual: "\u89c6\u89c9",
          A11y: "\u65e0\u969c\u788d",
        }[label] ?? label,
      ),
    ]),
  );
  return LAB_LENS_LABELS.filter(({ key }) => {
    const artifactPath = run.artifacts_ref[key];
    return typeof artifactPath === "string" && artifactPath.trim().length > 0;
  }).map(({ key, label }) => labelMap[key] ?? label);
};

const getLabArtifactEntries = (
  run: UniversalRun | null,
  locale: UiLocale,
): Array<{ key: string; label: string; path: string }> => {
  if (!run) {
    return [];
  }
  const labelMap = Object.fromEntries(
    LAB_LENS_LABELS.map(({ key, label }) => [
      key,
      pickUiText(
        locale,
        label,
        {
          Summary: "\u603b\u7ed3",
          Load: "\u8d1f\u8f7d",
          Perf: "\u6027\u80fd",
          Explore: "\u63a2\u7d22",
          Chaos: "\u6df7\u6c8c",
          Visual: "\u89c6\u89c9",
          A11y: "\u65e0\u969c\u788d",
        }[label] ?? label,
      ),
    ]),
  );
  return Object.entries(run.artifacts_ref)
    .filter(([, path]) => typeof path === "string" && path.trim().length > 0)
    .map(([key, path]) => ({
      key,
      label: labelMap[key] ?? key,
      path: path.trim(),
    }));
};

const getLabVerdict = (run: UniversalRun | null, locale: UiLocale): string => {
  if (!run) {
    return pickUiText(
      locale,
      "No lab run exists yet. Start in Stress Lab with a localhost-safe target and one lab mode.",
      "\u8fd8\u6ca1\u6709\u5b9e\u9a8c\u8fd0\u884c\u3002\u5148\u5728 Stress Lab \u91cc\u9009\u4e00\u4e2a localhost-safe \u76ee\u6807\uff0c\u518d\u542f\u52a8\u4e00\u79cd\u5b9e\u9a8c\u6a21\u5f0f\u3002",
    );
  }
  if (run.status === "success") {
    return pickUiText(
      locale,
      "The latest lab run completed. Review the lenses below before you rerun, refine the flow, or open deeper analysis.",
      "\u6700\u65b0\u5b9e\u9a8c\u5df2\u5b8c\u6210\u3002\u5148\u770b\u4e0b\u65b9 lens \u63d0\u793a\uff0c\u518d\u51b3\u5b9a\u662f\u91cd\u8dd1\u3001\u8c03\u6574 flow\uff0c\u8fd8\u662f\u8fdb\u5165\u66f4\u6df1\u5206\u6790\u3002",
    );
  }
  if (run.status === "failed") {
    return pickUiText(
      locale,
      "The latest lab run failed. Start with the failure message and available lenses, then rerun or switch experiment modes.",
      "\u6700\u65b0\u5b9e\u9a8c\u5931\u8d25\u4e86\u3002\u5148\u4ece\u5931\u8d25\u4fe1\u606f\u548c\u5df2\u6709 lens \u5165\u624b\uff0c\u518d\u51b3\u5b9a\u91cd\u8dd1\u6216\u5207\u6362\u5b9e\u9a8c\u6a21\u5f0f\u3002",
    );
  }
  if (run.status === "waiting_user" || run.status === "waiting_otp") {
    return pickUiText(
      locale,
      "The latest lab run is blocked on a manual gate. Clear the blocker here, then continue the experiment from the saved checkpoint.",
      "\u6700\u65b0\u5b9e\u9a8c\u5361\u5728\u4eba\u5de5\u95f8\u95e8\u4e0a\u3002\u5148\u5728\u8fd9\u91cc\u6e05\u6389\u963b\u585e\uff0c\u518d\u4ece\u5df2\u4fdd\u5b58\u7684 checkpoint \u7ee7\u7eed\u5b9e\u9a8c\u3002",
    );
  }
  if (run.status === "running" || run.status === "queued") {
    return pickUiText(
      locale,
      "The latest lab run is still settling. Stay in Runs & Blocks until it lands on a clear result or a manual gate.",
      "\u6700\u65b0\u5b9e\u9a8c\u8fd8\u5728\u843d\u5730\u4e2d\u3002\u7ee7\u7eed\u7559\u5728 Runs & Blocks\uff0c\u76f4\u5230\u5b83\u843d\u5728\u660e\u786e\u7ed3\u679c\u6216\u4eba\u5de5\u95f8\u95e8\u4e0a\u3002",
    );
  }
  return pickUiText(
    locale,
    "This lab run stopped before a final result. Review the queue entry and details, then retry if needed.",
    "\u8fd9\u6b21\u5b9e\u9a8c\u5728\u5f97\u5230\u6700\u7ec8\u7ed3\u679c\u524d\u5c31\u505c\u4e0b\u4e86\u3002\u5148\u770b\u961f\u5217\u8bb0\u5f55\u548c\u8be6\u60c5\uff0c\u6709\u9700\u8981\u518d\u91cd\u8bd5\u3002",
  );
};

const getLabNextStep = (run: UniversalRun | null, locale: UiLocale): string => {
  if (!run) {
    return pickUiText(
      locale,
      "Next step: choose a target URL and lab mode in Stress Lab.",
      "\u4e0b\u4e00\u6b65\uff1a\u5148\u5728 Stress Lab \u9009\u62e9\u76ee\u6807 URL \u548c\u5b9e\u9a8c\u6a21\u5f0f\u3002",
    );
  }
  if (run.status === "success") {
    return pickUiText(
      locale,
      "Next step: inspect the result, move to Flow Studio if the journey needs refinement, and open Advanced Review only for governed comparison.",
      "\u4e0b\u4e00\u6b65\uff1a\u5148\u8bfb\u7ed3\u679c\uff1b\u5982\u679c journey \u9700\u8981\u7ee7\u7eed\u6253\u78e8\uff0c\u5c31\u53bb Flow Studio\uff1b\u53ea\u6709\u9700\u8981\u6cbb\u7406\u5bf9\u6bd4\u65f6\u624d\u6253\u5f00 Advanced Review\u3002",
    );
  }
  if (run.status === "failed") {
    return pickUiText(
      locale,
      "Next step: inspect the failure, review the attached lenses, and rerun with refined parameters or a different lab mode.",
      "\u4e0b\u4e00\u6b65\uff1a\u5148\u68c0\u67e5\u5931\u8d25\uff0c\u770b\u9644\u5e26 lens\uff0c\u7136\u540e\u7528\u66f4\u7cbe\u51c6\u7684\u53c2\u6570\u6216\u53e6\u4e00\u79cd\u5b9e\u9a8c\u6a21\u5f0f\u91cd\u8dd1\u3002",
    );
  }
  if (run.status === "waiting_user" || run.status === "waiting_otp") {
    return pickUiText(
      locale,
      "Next step: complete the manual gate on this page, then continue the saved checkpoint.",
      "\u4e0b\u4e00\u6b65\uff1a\u5148\u5728\u8fd9\u4e2a\u9875\u9762\u5b8c\u6210\u4eba\u5de5\u95f8\u95e8\uff0c\u518d\u7ee7\u7eed\u5df2\u4fdd\u5b58\u7684 checkpoint\u3002",
    );
  }
  return pickUiText(
    locale,
    "Next step: keep watching this page until the run lands on success, failure, or a manual gate.",
    "\u4e0b\u4e00\u6b65\uff1a\u7ee7\u7eed\u5728\u8fd9\u4e2a\u9875\u9762\u7b49\uff0c\u76f4\u5230\u8fd9\u6b21 run \u843d\u5728\u6210\u529f\u3001\u5931\u8d25\u6216\u4eba\u5de5\u95f8\u95e8\u4e0a\u3002",
  );
};

function TaskCenterView({
  tasks,
  locale = DEFAULT_UI_LOCALE,
  taskState,
  selectedTaskId,
  taskErrorMessage,
  onSelectTask,
  onCancelTask,
  onRefreshTasks,
  statusFilter,
  onStatusFilterChange,
  commandFilter,
  onCommandFilterChange,
  taskLimit,
  onTaskLimitChange,
  logs,
  selectedTask,
  terminalRows,
  onTerminalRowsChange,
  terminalFilter,
  onTerminalFilterChange,
  autoScroll,
  onAutoScrollChange,
  onClearLogs,
  runs,
  selectedRunId,
  onSelectedRunIdChange,
  otpCode,
  onOtpCodeChange,
  onSubmitOtp,
  onGoToLaunch,
}: TaskCenterViewProps) {
  const commandQueueTitle = pickUiText(locale, commandLaneTitle, "\u547d\u4ee4\u961f\u5217");
  const labRunsTitle = pickUiText(locale, workflowLaneTitle, "\u5b9e\u9a8c\u8fd0\u884c");
  const commandLaneSource = pickUiText(locale, commandLaneSourceLabel, "\u547d\u4ee4\u961f\u5217\u9879");
  const workflowLaneSource = pickUiText(locale, workflowLaneSourceLabel, "\u5b9e\u9a8c\u8fd0\u884c");
  const [subTab, setSubTab] = useState<"tasks" | "runs">("tasks");
  const subTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const waitingRuns = useMemo(
    () => runs.filter((run) => run.status === "waiting_otp" || run.status === "waiting_user"),
    [runs],
  );
  const failedRuns = useMemo(() => runs.filter((run) => run.status === "failed"), [runs]);
  const completedRuns = useMemo(() => runs.filter((run) => run.status === "success"), [runs]);
  const manualGateReasons = useMemo(() => {
    const labels = waitingRuns
      .map((run) => run.wait_context?.screen_title || run.wait_context?.reason_code || run.status)
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(labels));
  }, [waitingRuns]);

  const selectedRun = runs.find((r) => r.run_id === selectedRunId) ?? null;
  const selectedRunIsProviderProtectedWait = isProviderProtectedPaymentWait(selectedRun);
  const trimmedOtpCode = otpCode.trim();
  const isOtpRun = selectedRun?.status === "waiting_otp";
  const isOtpFormatValid = OTP_DIGITS_PATTERN.test(trimmedOtpCode);
  const otpValidationError =
    isOtpRun && trimmedOtpCode.length > 0 && !isOtpFormatValid
      ? pickUiText(locale, "OTP must be 4-8 digits.", "OTP 必须是 4-8 位数字。")
      : null;
  const canSubmitWaitingInput = selectedRunIsProviderProtectedWait
    ? true
    : isOtpRun
      ? isOtpFormatValid
      : trimmedOtpCode.length > 0;
  const selectedRunIndex = useMemo(
    () => runs.findIndex((run) => run.run_id === selectedRunId),
    [runs, selectedRunId],
  );
  const selectedRunOptionId =
    selectedRunIndex >= 0
      ? `task-center-template-option-${runs[selectedRunIndex].run_id}`
      : undefined;
  const latestLabRun = selectedRun ?? runs[0] ?? null;
  const latestLabTarget = getLabTarget(latestLabRun, locale);
  const latestLabLenses = getLabLensLabels(latestLabRun, locale);
  const latestLabArtifacts = getLabArtifactEntries(latestLabRun, locale);
  const latestLabVerdict = getLabVerdict(latestLabRun, locale);
  const latestLabNextStep = getLabNextStep(latestLabRun, locale);
  const runRecordDetailHintText = getRunRecordDetailHintText(locale);

  const focusSubTab = useCallback((targetIndex: number) => {
    const normalizedIndex = ((targetIndex % subTabCount) + subTabCount) % subTabCount;
    subTabRefs.current[normalizedIndex]?.focus();
  }, []);

  const activateSubTab = useCallback((targetIndex: number) => {
    const normalizedIndex = ((targetIndex % subTabCount) + subTabCount) % subTabCount;
    setSubTab(subTabOrder[normalizedIndex]);
  }, []);

  const handleSubTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        focusSubTab(index + 1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusSubTab(index - 1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusSubTab(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        focusSubTab(subTabCount - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateSubTab(index);
      }
    },
    [activateSubTab, focusSubTab],
  );

  const handleTemplateRunsListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLUListElement>) => {
      if (runs.length === 0) return;
      const currentIndex = selectedRunIndex >= 0 ? selectedRunIndex : 0;
      let nextIndex = currentIndex;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        nextIndex = (currentIndex + 1) % runs.length;
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        nextIndex = (currentIndex - 1 + runs.length) % runs.length;
      } else if (event.key === "Home") {
        event.preventDefault();
        nextIndex = 0;
      } else if (event.key === "End") {
        event.preventDefault();
        nextIndex = runs.length - 1;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelectedRunIdChange(runs[currentIndex].run_id);
        return;
      } else {
        return;
      }

      onSelectedRunIdChange(runs[nextIndex].run_id);
    },
    [onSelectedRunIdChange, runs, selectedRunIndex],
  );

  const formatRunErrorMessage = (message: string): string =>
    formatActionableErrorMessage(message, {
      action: pickUiText(
        locale,
        "Correct the current step input and retry.",
        "\u5148\u4fee\u6b63\u5f53\u524d\u6b65\u9aa4\u8f93\u5165\uff0c\u518d\u91cd\u8bd5\u3002",
      ),
      troubleshootingEntry: pickUiText(
        locale,
        "Review the run log on this page together with the Runs & Blocks details.",
        "\u8bf7\u7ed3\u5408\u8fd9\u4e2a\u9875\u9762\u7684 run log \u548c Runs & Blocks \u8be6\u60c5\u4e00\u8d77\u6392\u67e5\u3002",
      ),
    });

  return (
    <div
      className="task-center-view"
      id="app-view-tasks-panel"
      role="tabpanel"
      aria-labelledby="console-tab-tasks"
    >
      <div className="task-list-column" data-testid={TASK_CENTER_LIST_COLUMN_TEST_ID}>
        <div
          className="flex-row gap-2 mb-3"
          role="tablist"
          aria-label={pickUiText(locale, "Runs and Blocks lanes", "\u8fd0\u884c\u4e0e\u963b\u585e\u5206\u680f")}
        >
          <button
            type="button"
            ref={(node) => {
              subTabRefs.current[0] = node;
            }}
            id={subTabIds.tasks}
            className={`category-tab ${subTab === "tasks" ? "active" : ""}`}
            role="tab"
            aria-selected={subTab === "tasks"}
            aria-controls={subPanelIds.tasks}
            tabIndex={subTab === "tasks" ? 0 : -1}
            onClick={() => setSubTab("tasks")}
            onKeyDown={(event) => handleSubTabKeyDown(event, 0)}
            data-testid={TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID}
          >
            {commandQueueTitle}
            <span className="cat-count">{tasks.length}</span>
          </button>
          <button
            type="button"
            ref={(node) => {
              subTabRefs.current[1] = node;
            }}
            id={subTabIds.runs}
            className={`category-tab ${subTab === "runs" ? "active" : ""}`}
            role="tab"
            aria-selected={subTab === "runs"}
            aria-controls={subPanelIds.runs}
            tabIndex={subTab === "runs" ? 0 : -1}
            onClick={() => setSubTab("runs")}
            onKeyDown={(event) => handleSubTabKeyDown(event, 1)}
            data-testid={TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID}
          >
            {labRunsTitle}
            <span className="cat-count">{runs.length}</span>
          </button>
        </div>

        <div
          id={subPanelIds.tasks}
          role="tabpanel"
          aria-labelledby={subTabIds.tasks}
          hidden={subTab !== "tasks"}
          data-testid={TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID}
        >
          <TaskListPanel
            tasks={tasks}
            locale={locale}
            taskState={taskState}
            selectedTaskId={selectedTaskId}
            taskErrorMessage={taskErrorMessage}
            onSelectTask={onSelectTask}
            onCancelTask={onCancelTask}
            onRefresh={onRefreshTasks}
            statusFilter={statusFilter}
            onStatusFilterChange={onStatusFilterChange}
            commandFilter={commandFilter}
            onCommandFilterChange={onCommandFilterChange}
            taskLimit={taskLimit}
            onTaskLimitChange={onTaskLimitChange}
            listTitle={commandQueueTitle}
            sourceLabel={commandLaneSource}
            emptyTitle={pickUiText(locale, "No command runs yet", "\u8fd8\u6ca1\u6709\u547d\u4ee4\u8fd0\u884c")}
            emptyDescription={pickUiText(
              locale,
              "Start a command from Stress Lab. This lane will show queue status, retries, and output for each command run.",
              "\u5148\u5728 Stress Lab \u53d1\u8d77\u4e00\u6761\u547d\u4ee4\u3002\u8fd9\u6761\u961f\u5217\u4f1a\u663e\u793a\u6bcf\u6b21\u547d\u4ee4\u8fd0\u884c\u7684\u6392\u961f\u72b6\u6001\u3001\u91cd\u8bd5\u548c\u8f93\u51fa\u3002",
            )}
          />
        </div>
        <div
          id={subPanelIds.runs}
          role="tabpanel"
          aria-labelledby={subTabIds.runs}
          hidden={subTab !== "runs"}
          data-testid={TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID}
        >
          <div className="card-raised mb-3 p-3">
            <h3 className="section-subtitle m-0">
              {pickUiText(locale, "Latest lab result", "\u6700\u65b0\u5b9e\u9a8c\u7ed3\u679c")}
            </h3>
            <p className="hint-text mt-2">
              {pickUiText(
                locale,
                "Runs & Blocks is the result desk for the latest browser experiment. Start in Stress Lab, then come here to read the verdict, spot blockers, and decide whether to rerun or refine.",
                "Runs & Blocks \u662f\u6700\u65b0\u6d4f\u89c8\u5668\u5b9e\u9a8c\u7684\u7ed3\u679c\u53f0\u3002\u5148\u5728 Stress Lab \u53d1\u8d77\u5b9e\u9a8c\uff0c\u518d\u6765\u8fd9\u91cc\u8bfb\u7ed3\u8bba\u3001\u627e\u963b\u585e\uff0c\u5e76\u51b3\u5b9a\u91cd\u8dd1\u8fd8\u662f\u7ee7\u7eed\u4f18\u5316\u3002",
              )}
            </p>
            <DetailFieldRow
              fields={[
                { label: pickUiText(locale, "Target", "\u76ee\u6807"), value: latestLabTarget },
                {
                  label: pickUiText(locale, "Status", "\u72b6\u6001"),
                  value: latestLabRun
                    ? localizeRunStatus(locale, latestLabRun.status)
                    : pickUiText(locale, "No run yet", "\u8fd8\u6ca1\u6709\u8fd0\u884c"),
                },
                {
                  label: pickUiText(locale, "Updated", "\u66f4\u65b0\u65f6\u95f4"),
                  value: latestLabRun
                    ? formatDateTime(latestLabRun.updated_at, locale)
                    : pickUiText(locale, "Not started", "\u672a\u5f00\u59cb"),
                },
              ]}
            />
            <p className="hint-text mt-2">{latestLabVerdict}</p>
            {latestLabLenses.length > 0 ? (
              <div className="command-tags mt-2">
                {latestLabLenses.map((lens) => (
                  <Badge key={lens} variant="secondary">
                    {lens}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  "No capability report is attached yet. Once the run writes summary or lens artifacts, they show up here as reading hints.",
                  "\u8fd8\u6ca1\u6709\u9644\u5e26\u80fd\u529b\u62a5\u544a\u3002\u4e00\u65e6 run \u5199\u5165 summary \u6216 lens artifact\uff0c\u5b83\u4eec\u5c31\u4f1a\u5728\u8fd9\u91cc\u4f5c\u4e3a\u9605\u8bfb\u63d0\u793a\u51fa\u73b0\u3002",
                )}
              </p>
            )}
            <div className="command-tags mt-2">
              <Badge variant="secondary">
                {pickUiText(locale, `waiting=${waitingRuns.length}`, `\u7b49\u5f85=${waitingRuns.length}`)}
              </Badge>
              <Badge variant="secondary">
                {pickUiText(locale, `failed=${failedRuns.length}`, `\u5931\u8d25=${failedRuns.length}`)}
              </Badge>
              <Badge variant="secondary">
                {pickUiText(
                  locale,
                  `succeeded=${completedRuns.length}`,
                  `\u6210\u529f=${completedRuns.length}`,
                )}
              </Badge>
            </div>
            <p className="hint-text mt-2">{latestLabNextStep}</p>
            {latestLabArtifacts.length > 0 && (
              <div className="mt-3">
                <p className="field-label">{pickUiText(locale, "Report surface", "\u62a5\u544a\u9762\u677f")}</p>
                <p className="hint-text mt-2">
                  {pickUiText(
                    locale,
                    "Use these run-owned report paths to inspect the latest experiment before you escalate into deeper governed review.",
                    "\u5148\u7528\u8fd9\u4e9b run \u81ea\u5e26\u7684\u62a5\u544a\u8def\u5f84\u770b\u61c2\u6700\u65b0\u5b9e\u9a8c\uff0c\u518d\u51b3\u5b9a\u662f\u5426\u5347\u7ea7\u5230\u66f4\u6df1\u7684\u6cbb\u7406\u5ba1\u67e5\u3002",
                  )}
                </p>
                <ul
                  className="task-list mt-2"
                  aria-label={pickUiText(
                    locale,
                    "Latest lab report surface",
                    "\u6700\u65b0\u5b9e\u9a8c\u62a5\u544a\u9762\u677f",
                  )}
                >
                  {latestLabArtifacts.slice(0, 6).map((artifact) => (
                    <li key={`${artifact.key}:${artifact.path}`} className="task-item">
                      <div className="task-item-info text-left">
                        <strong>{artifact.label}</strong>
                        <p>{artifact.path}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {waitingRuns.length > 0 ? (
              <div className="mt-3">
                <p className="hint-text mt-2">
                  {pickUiText(
                    locale,
                    `Manual Gate inbox: ${waitingRuns.length} lab run(s) need operator help right now. Reasons: ${manualGateReasons.join(", ") || "manual review"}.`,
                    `\u4eba\u5de5\u95f8\u95e8\u6536\u4ef6\u7bb1\uff1a\u73b0\u5728\u6709 ${waitingRuns.length} \u4e2a\u5b9e\u9a8c\u8fd0\u884c\u9700\u8981\u4eba\u5de5\u534f\u52a9\u3002\u539f\u56e0\uff1a${manualGateReasons.join("，") || "\u4eba\u5de5\u5ba1\u67e5"}\u3002`,
                  )}
                </p>
                <ul
                  className="task-list mt-2"
                  aria-label={pickUiText(
                    locale,
                    "Waiting lab runs needing operator help",
                    "\u7b49\u5f85\u4eba\u5de5\u534f\u52a9\u7684\u5b9e\u9a8c\u8fd0\u884c",
                  )}
                >
                  {waitingRuns.slice(0, 3).map((run) => (
                    <li key={run.run_id} className="task-item">
                      <div className="task-item-info text-left">
                        <strong>
                          {pickUiText(
                            locale,
                            `Run #${run.run_id.slice(0, 8)} \u00b7 ${getLabTarget(run, locale)}`,
                            `\u8fd0\u884c #${run.run_id.slice(0, 8)} \u00b7 ${getLabTarget(run, locale)}`,
                          )}
                        </strong>
                        <p>
                          {run.wait_context?.screen_title ||
                            run.wait_context?.reason_code ||
                            pickUiText(locale, "manual review", "\u4eba\u5de5\u5ba1\u67e5")}
                        </p>
                      </div>
                      <Badge variant="secondary">{localizeRunStatus(locale, run.status)}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  "No lab run is waiting for operator input right now. When a run pauses for OTP or manual approval, this page becomes the inbox to clear it.",
                  "\u5f53\u524d\u6ca1\u6709\u5b9e\u9a8c\u8fd0\u884c\u5728\u7b49\u5f85\u4eba\u5de5\u8f93\u5165\u3002\u4ee5\u540e\u9047\u5230 OTP \u6216\u4eba\u5de5\u6279\u51c6\u6682\u505c\u65f6\uff0c\u8fd9\u91cc\u5c31\u662f\u4f60\u7684\u5904\u7406\u6536\u4ef6\u7bb1\u3002",
                )}
              </p>
            )}
          </div>
          <div className="form-row justify-between">
            <h2 className="section-title m-0">{labRunsTitle}</h2>
            <Button variant="ghost" size="sm" onClick={onRefreshTasks}>
              {pickUiText(locale, "Refresh", "\u5237\u65b0")}
            </Button>
          </div>
          {runs.length === 0 ? (
            <EmptyState
              icon={
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 12h8" />
                </svg>
              }
              title={pickUiText(locale, "No lab runs yet", "\u8fd8\u6ca1\u6709\u5b9e\u9a8c\u8fd0\u884c")}
              description={pickUiText(
                locale,
                "Start a saved template or guided run from Stress Lab. This lane will show step progress, pause states, and resume checkpoints.",
                "\u5148\u4ece Stress Lab \u53d1\u8d77\u6a21\u677f\u8fd0\u884c\u6216\u5f15\u5bfc\u8fd0\u884c\u3002\u8fd9\u4e2a\u533a\u57df\u4f1a\u663e\u793a\u6b65\u9aa4\u8fdb\u5ea6\u3001\u6682\u505c\u72b6\u6001\u548c\u6062\u590d\u68c0\u67e5\u70b9\u3002",
              )}
              action={{ label: pickUiText(locale, "Go to Stress Lab", "\u524d\u5f80 Stress Lab"), onClick: onGoToLaunch }}
            />
          ) : (
            <ul
              className="task-list"
              role="listbox"
              aria-label={pickUiText(locale, "Lab run list (templates)", "\u5b9e\u9a8c\u8fd0\u884c\u5217\u8868\uff08\u6a21\u677f\uff09")}
              aria-activedescendant={selectedRunOptionId}
              tabIndex={0}
              onKeyDown={handleTemplateRunsListKeyDown}
            >
              {runs.map((run) => (
                <li
                  key={run.run_id}
                  id={`task-center-template-option-${run.run_id}`}
                  className={`task-item ${selectedRunId === run.run_id ? "active" : ""}`}
                  role="option"
                  aria-selected={selectedRunId === run.run_id}
                  onClick={() => onSelectedRunIdChange(run.run_id)}
                >
                  <div className="task-item-info text-left">
                    <strong>
                      {pickUiText(
                        locale,
                        `${workflowLaneSource} \u00B7 Record #${run.run_id.slice(0, 8)}`,
                        `${workflowLaneSource} \u00B7 \u8bb0\u5f55 #${run.run_id.slice(0, 8)}`,
                      )}
                    </strong>
                    <p>
                      {pickUiText(
                        locale,
                        `Template ${run.template_id.slice(0, 8)} \u00B7 ${localizeRunStatus(locale, run.status)} \u00B7 Step ${run.step_cursor}`,
                        `\u6a21\u677f ${run.template_id.slice(0, 8)} \u00B7 ${localizeRunStatus(locale, run.status)} \u00B7 \u6b65\u9aa4 ${run.step_cursor}`,
                      )}
                    </p>
                  </div>
                  <Badge
                    variant={
                      run.status === "failed" || run.status === "cancelled"
                        ? "destructive"
                        : run.status === "success"
                          ? "default"
                          : "secondary"
                    }
                    className={run.status === "success" ? "success-chip" : undefined}
                  >
                    {localizeRunStatus(locale, run.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="task-detail-column" data-testid={TASK_CENTER_DETAIL_COLUMN_TEST_ID}>
        {subTab === "tasks" ? (
          selectedTask ? (
            <RunDetailCard
              title={pickUiText(
                locale,
                `Command run #${selectedTask.task_id.slice(0, 8)}`,
                `\u547d\u4ee4\u8fd0\u884c #${selectedTask.task_id.slice(0, 8)}`,
              )}
              status={selectedTask.status}
              isSuccess={selectedTask.status === "success"}
              detailHint={runRecordDetailHintText}
            >
              <DetailFieldRow
                fields={[
                  { label: pickUiText(locale, "Lane", "\u5206\u680f"), value: commandLaneSource },
                  {
                    label: pickUiText(locale, "Command ID", "\u547d\u4ee4 ID"),
                    value: selectedTask.command_id,
                  },
                  {
                    label: pickUiText(locale, "Attempt", "\u5c1d\u8bd5\u6b21\u6570"),
                    value: `${selectedTask.attempt} / ${selectedTask.max_attempts}`,
                  },
                ]}
              />
              <DetailFieldRow
                fields={[
                  {
                    label: pickUiText(locale, "Created at", "\u521b\u5efa\u65f6\u95f4"),
                    value: formatDateTime(selectedTask.created_at, locale),
                  },
                  selectedTask.finished_at
                    ? {
                        label: pickUiText(locale, "Finished at", "\u5b8c\u6210\u65f6\u95f4"),
                        value: formatDateTime(selectedTask.finished_at, locale),
                      }
                    : null,
                ]}
              />
              {selectedTask.message && (
                <div className="field">
                  <span className="field-label">{pickUiText(locale, "Message", "消息")}</span>
                  <span className="hint-text">{selectedTask.message}</span>
                </div>
              )}
              {selectedTask.exit_code !== null && selectedTask.exit_code !== undefined && (
                <div className="field">
                  <span className="field-label">{pickUiText(locale, "Exit code", "退出码")}</span>
                  <span className="text-sm">{selectedTask.exit_code}</span>
                </div>
              )}
            </RunDetailCard>
          ) : (
            <EmptyState
              icon={
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 9h6M9 13h4" />
                </svg>
              }
              title={pickUiText(locale, "Select a command run to view details", "选择命令运行以查看详情")}
              description={pickUiText(
                locale,
                "Choose a command run from the left lane to inspect queue status, attempts, and output logs.",
                "从左侧选择一条命令运行，即可查看队列状态、尝试次数和输出日志。",
              )}
            />
          )
        ) : selectedRun ? (
          <RunDetailCard
            title={pickUiText(
              locale,
              `Lab run #${selectedRun.run_id.slice(0, 8)}`,
              `\u5b9e\u9a8c\u8fd0\u884c #${selectedRun.run_id.slice(0, 8)}`,
            )}
            status={localizeRunStatus(locale, selectedRun.status)}
            isSuccess={selectedRun.status === "success"}
            detailHint={runRecordDetailHintText}
          >
              <DetailFieldRow
                fields={[
                  { label: pickUiText(locale, "Lane", "\u5206\u680f"), value: workflowLaneSource },
                  {
                    label: pickUiText(locale, "Template ID", "\u6a21\u677f ID"),
                    value: selectedRun.template_id.slice(0, 12),
                  },
                  {
                    label: pickUiText(locale, "Step progress", "\u6b65\u9aa4\u8fdb\u5ea6"),
                    value: pickUiText(
                      locale,
                      `Step ${selectedRun.step_cursor}`,
                      `\u6b65\u9aa4 ${selectedRun.step_cursor}`,
                    ),
                  },
                ]}
              />
              <DetailFieldRow
                fields={[
                  {
                    label: pickUiText(locale, "Created at", "\u521b\u5efa\u65f6\u95f4"),
                    value: formatDateTime(selectedRun.created_at, locale),
                  },
                ]}
              />
            {selectedRun.last_error && (
              <div className="field">
                <span className="field-label">{pickUiText(locale, "Last error", "最后错误")}</span>
                <span className="error-text">{formatRunErrorMessage(selectedRun.last_error)}</span>
              </div>
            )}
            {(selectedRun.status === "waiting_otp" || selectedRun.status === "waiting_user") && (
              <ManualGateDesk
                run={selectedRun}
                locale={locale}
                otpCode={selectedRunIsProviderProtectedWait ? "" : otpCode}
                otpValidationError={selectedRunIsProviderProtectedWait ? null : otpValidationError}
                canSubmitWaitingInput={
                  selectedRunIsProviderProtectedWait ? true : canSubmitWaitingInput
                }
                onOtpCodeChange={onOtpCodeChange}
                onSubmit={onSubmitOtp}
              />
            )}
            {selectedRun.logs && selectedRun.logs.length > 0 && (
              <div className="mt-3">
                <h3 className="section-subtitle">{pickUiText(locale, "Run log", "运行日志")}</h3>
                <LogStream logs={selectedRun.logs} />
              </div>
            )}
          </RunDetailCard>
        ) : (
          <EmptyState
            icon={
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 9h6M9 13h4" />
              </svg>
            }
              title={pickUiText(locale, "Select a lab run to view details", "\u9009\u62e9\u5b9e\u9a8c\u8fd0\u884c\u4ee5\u67e5\u770b\u8be6\u60c5")}
              description={pickUiText(
                locale,
                "Choose a lab run from the left lane to inspect step progress, pause context, parameters, and logs.",
                "\u4ece\u5de6\u4fa7\u9009\u62e9\u4e00\u4e2a\u5b9e\u9a8c\u8fd0\u884c\uff0c\u5373\u53ef\u67e5\u770b\u6b65\u9aa4\u8fdb\u5ea6\u3001\u6682\u505c\u4e0a\u4e0b\u6587\u3001\u53c2\u6570\u548c\u65e5\u5fd7\u3002",
              )}
            />
          )}
      </div>

      <div className="task-terminal-column">
        <TerminalPanel
          logs={logs}
          locale={locale}
          selectedTask={selectedTask}
          terminalRows={terminalRows}
          onTerminalRowsChange={onTerminalRowsChange}
          terminalFilter={terminalFilter}
          onTerminalFilterChange={onTerminalFilterChange}
          autoScroll={autoScroll}
          onAutoScrollChange={onAutoScrollChange}
          onClear={onClearLogs}
        />
      </div>
    </div>
  );
}

export default memo(TaskCenterView);
