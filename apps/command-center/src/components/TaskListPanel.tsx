import { memo } from "react";
import { isCancelableStatus } from "../features/command-center/status";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { formatActionableErrorMessage } from "../shared/errorFormatter";
import type { Task, TaskState } from "../types";
import { Badge, Button, Card, CardContent } from "./ui";

function localizeTaskStatus(locale: UiLocale, status: Task["status"]): string {
  return pickUiText(
    locale,
    {
      queued: "Queued",
      running: "Running",
      success: "Succeeded",
      failed: "Failed",
      cancelled: "Cancelled",
    }[status],
    {
      queued: "排队中",
      running: "运行中",
      success: "已成功",
      failed: "已失败",
      cancelled: "已取消",
    }[status],
  );
}

interface TaskListPanelProps {
  tasks: Task[];
  locale?: UiLocale;
  taskState: TaskState;
  selectedTaskId: string;
  taskErrorMessage: string;
  onSelectTask: (taskId: string) => void;
  onCancelTask: (task: Task) => void;
  onRefresh: () => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  commandFilter: string;
  onCommandFilterChange: (value: string) => void;
  taskLimit: number;
  onTaskLimitChange: (value: number) => void;
  listTitle?: string;
  sourceLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

function TaskListPanel({
  tasks,
  locale = DEFAULT_UI_LOCALE,
  taskState,
  selectedTaskId,
  taskErrorMessage,
  onSelectTask,
  onCancelTask,
  onRefresh,
  statusFilter,
  onStatusFilterChange,
  commandFilter,
  onCommandFilterChange,
  taskLimit,
  onTaskLimitChange,
  listTitle = "Command runs",
  sourceLabel = "Command run",
  emptyTitle = "No command runs yet",
  emptyDescription = "Start a command from Stress Lab to populate this lane with queue status, retries, and result output.",
}: TaskListPanelProps) {
  const isLoading = taskState === "loading";
  const formatTaskErrorMessage = (message: string) =>
    formatActionableErrorMessage(message, {
      action: pickUiText(
        locale,
        "Click Refresh and try again. If needed, start the run again.",
        "先点击刷新再试一次；如果还有问题，就重新启动这条运行。",
      ),
      troubleshootingEntry: pickUiText(
        locale,
        "Check the details panel and the run log on the right.",
        "请查看右侧详情面板和运行日志。",
      ),
    });

  return (
    <>
      <div className="form-row justify-between">
        <h2 className="section-title m-0">{listTitle}</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          loading={isLoading}
          data-testid="tasklist-refresh"
        >
          {pickUiText(locale, "Refresh", "刷新")}
        </Button>
      </div>
      <div className="task-filters">
        <select
          className="field-select"
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value)}
          aria-label={pickUiText(locale, "Filter tasks by status", "按状态筛选任务")}
          disabled={isLoading}
        >
          <option value="all">{pickUiText(locale, "All statuses", "全部状态")}</option>
          <option value="queued">{localizeTaskStatus(locale, "queued")}</option>
          <option value="running">{localizeTaskStatus(locale, "running")}</option>
          <option value="success">{localizeTaskStatus(locale, "success")}</option>
          <option value="failed">{localizeTaskStatus(locale, "failed")}</option>
          <option value="cancelled">{localizeTaskStatus(locale, "cancelled")}</option>
        </select>
        <input
          className="field-input"
          type="text"
          placeholder={pickUiText(locale, "Filter by command ID", "按命令 ID 筛选")}
          value={commandFilter}
          onChange={(e) => onCommandFilterChange(e.target.value)}
          aria-label={pickUiText(locale, "Filter command runs by command ID", "按命令 ID 筛选命令运行")}
          disabled={isLoading}
        />
        <select
          className="field-select w-select-limit"
          value={String(taskLimit)}
          onChange={(e) => onTaskLimitChange(Number(e.target.value))}
          aria-label={pickUiText(locale, "Task limit", "任务上限")}
          disabled={isLoading}
        >
          <option value="20">{pickUiText(locale, "20 items", "20 条")}</option>
          <option value="50">{pickUiText(locale, "50 items", "50 条")}</option>
          <option value="100">{pickUiText(locale, "100 items", "100 条")}</option>
          <option value="200">{pickUiText(locale, "200 items", "200 条")}</option>
        </select>
      </div>
      {taskErrorMessage && (
        <p className="error-text" role="alert" aria-live="assertive" aria-atomic="true">
          {formatTaskErrorMessage(taskErrorMessage)}
        </p>
      )}
      {taskState === "loading" && (
        <Card className="loading-card min-h-60" role="status" aria-live="polite" aria-atomic="true">
          <CardContent>
            <div className="spinner" />
            <p className="empty-state-title mt-3">
              {pickUiText(locale, "Loading command runs", "正在加载命令运行")}
            </p>
            <p className="empty-state-desc">
              {pickUiText(
                locale,
                "Waiting for the automation command lane to answer. When it responds, the newest command runs will appear here with the latest lab output.",
                "正在等待自动化命令队列返回结果。等它响应后，最新命令运行和实验输出就会出现在这里。",
              )}
            </p>
          </CardContent>
        </Card>
      )}
      <ul className="task-list" aria-label={pickUiText(locale, "Command run list", "命令运行列表")}>
        {!isLoading &&
          tasks.map((task) => (
            <li
              key={task.task_id}
              className={`task-item ${selectedTaskId === task.task_id ? "active" : ""}`}
            >
              <Button
                variant="ghost"
                size="sm"
                className="task-item-info text-left"
                aria-current={selectedTaskId === task.task_id ? "true" : undefined}
                onClick={() => onSelectTask(task.task_id)}
                data-testid="task-item-open"
              >
                <strong>{`${sourceLabel} \u00B7 ${task.command_id}`}</strong>
                <p>
                  <Badge
                    variant={
                      task.status === "failed" || task.status === "cancelled"
                        ? "destructive"
                        : "secondary"
                    }
                    className="chip"
                  >
                    {localizeTaskStatus(locale, task.status)}
                  </Badge>
                  {pickUiText(locale, " \u00B7 Run #", " \u00B7 运行 #")}
                  {task.task_id.slice(0, 8)}
                </p>
              </Button>
              {isCancelableStatus(task.status) && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => onCancelTask(task)}
                  data-testid="task-item-cancel"
                >
                  {pickUiText(locale, "Cancel", "取消")}
                </Button>
              )}
            </li>
          ))}
        {taskState === "empty" && (
          <li className="task-empty">
            <div className="empty-state">
              <div className="empty-state-icon">
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
              </div>
              <p className="empty-state-title">{emptyTitle}</p>
              <p className="empty-state-desc">{emptyDescription}</p>
            </div>
          </li>
        )}
        {taskState === "error" && (
          <li className="task-empty error-text">
            {formatTaskErrorMessage(
              taskErrorMessage ||
                pickUiText(locale, "The task list could not be loaded.", "任务列表加载失败。"),
            )}
          </li>
        )}
      </ul>
    </>
  );
}

export default memo(TaskListPanel);
