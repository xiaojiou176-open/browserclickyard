import { memo, useEffect, useMemo, useRef } from "react";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import type { LogEntry, LogLevel, Task } from "../types";
import { Button, Card, CardContent, CardFooter, CardHeader, CardTitle } from "./ui";

const logPrefix: Record<LogLevel, string> = {
  info: "INFO",
  success: " OK ",
  warn: "WARN",
  error: " ERR",
};

interface TerminalPanelProps {
  logs: LogEntry[];
  locale?: UiLocale;
  selectedTask: Task | null;
  terminalRows: number;
  onTerminalRowsChange: (rows: number) => void;
  terminalFilter: "all" | LogLevel;
  onTerminalFilterChange: (filter: "all" | LogLevel) => void;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  onClear: () => void;
}

function TerminalPanel({
  logs,
  locale = DEFAULT_UI_LOCALE,
  selectedTask,
  terminalRows,
  onTerminalRowsChange,
  terminalFilter,
  onTerminalFilterChange,
  autoScroll,
  onAutoScrollChange,
  onClear,
}: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null);

  const filteredLogs = useMemo(() => {
    if (terminalFilter === "all") {
      return logs;
    }
    return logs.filter((log) => log.level === terminalFilter);
  }, [logs, terminalFilter]);

  useEffect(() => {
    if (!autoScroll) {
      return;
    }
    const box = terminalRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [autoScroll, filteredLogs]);

  return (
    <Card
      className="terminal-card"
      as="section"
      aria-label={pickUiText(locale, "Live terminal", "实时终端")}
    >
      <CardHeader className="terminal-head">
        <div className="terminal-head-left">
          <div className="terminal-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <CardTitle as="h2">{pickUiText(locale, "Terminal", "终端")}</CardTitle>
        </div>
        <div className="terminal-actions">
          <label htmlFor="terminal-size" className="inline-check gap-8">
            {pickUiText(locale, "Height", "高度")}
            <input
              id="terminal-size"
              type="range"
              min={6}
              max={30}
              value={terminalRows}
              onChange={(e) => onTerminalRowsChange(Number(e.target.value))}
              aria-valuetext={pickUiText(locale, `${terminalRows} rows`, `${terminalRows} 行`)}
              data-testid="terminal-height"
            />
          </label>
          <select
            className="field-select"
            value={terminalFilter}
            onChange={(e) => onTerminalFilterChange(e.target.value as "all" | LogLevel)}
            aria-label={pickUiText(locale, "Log level filter", "日志级别筛选")}
            data-testid="terminal-filter"
          >
            <option value="all">{pickUiText(locale, "All", "全部")}</option>
            <option value="info">{"INFO"}</option>
            <option value="success">{"OK"}</option>
            <option value="warn">{"WARN"}</option>
            <option value="error">{"ERR"}</option>
          </select>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => onAutoScrollChange(e.target.checked)}
              data-testid="terminal-autoscroll"
            />
            {pickUiText(locale, "Auto-scroll", "自动滚动")}
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            data-testid="terminal-clear"
          >
            {pickUiText(locale, "Clear", "清空")}
          </Button>
        </div>
      </CardHeader>
      <CardContent
        ref={terminalRef}
        className="terminal-body"
        role="log"
        aria-live="polite"
        style={{ minHeight: `${terminalRows * 1.5}rem` }}
      >
        {filteredLogs.length === 0 ? (
          <span className="log-empty">{pickUiText(locale, "Terminal log is empty", "终端日志为空")}</span>
        ) : (
          filteredLogs.map((log) => (
            <span key={log.id} className="log-line">
              <span className="log-time">{new Date(log.ts).toLocaleTimeString()}</span>{" "}
              <span className={`log-tag ${log.level}`}>[{logPrefix[log.level]}]</span> {log.message}
              {"\n"}
            </span>
          ))
        )}
      </CardContent>
      {selectedTask && (
        <CardFooter
          className="terminal-sub"
          aria-label={pickUiText(locale, "Current task output", "当前任务输出")}
        >
          {selectedTask.output_tail ||
            pickUiText(
              locale,
              `Task ${selectedTask.task_id} has no output yet`,
              `任务 ${selectedTask.task_id} 目前还没有输出`,
            )}
        </CardFooter>
      )}
    </Card>
  );
}

export default memo(TerminalPanel);
