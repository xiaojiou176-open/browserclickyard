import { memo } from "react";
import EmptyState from "../components/EmptyState";
import EvidenceScreenshotPair from "../components/EvidenceScreenshotPair";
import FlowDraftEditor from "../components/FlowDraftEditor";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "../components/ui";
import { FLOW_WORKSHOP_EDITOR_COLUMN_TEST_ID } from "../constants/testIds";
import type {
  AlertsPayload,
  DiagnosticsPayload,
  EvidenceTimelineItem,
  FlowEditableDraft,
  FlowPreviewPayload,
  StepEvidencePayload,
} from "../types";

interface FlowWorkshopViewProps {
  locale?: UiLocale;
  diagnostics: DiagnosticsPayload | null;
  alerts: AlertsPayload | null;
  diagnosticsError: string;
  alertError: string;
  latestFlow: FlowPreviewPayload | null;
  flowError: string;
  flowDraft: FlowEditableDraft | null;
  selectedStepId: string;
  stepEvidence: StepEvidencePayload | null;
  evidenceTimeline: EvidenceTimelineItem[];
  evidenceTimelineError: string;
  resumeWithPreconditions: boolean;
  stepEvidenceError: string;
  onFlowDraftChange: (next: FlowEditableDraft) => void;
  onSelectStep: (stepId: string) => void;
  onResumeWithPreconditionsChange: (enabled: boolean) => void;
  onSaveFlowDraft: () => void;
  onPromoteTemplate: () => void;
  onReplayLatestFlow: () => void;
  onReplayStep: (stepId: string) => void;
  onResumeFromStep: (stepId: string) => void;
  onRefresh: () => void;
}

function FlowWorkshopView({
  locale = DEFAULT_UI_LOCALE,
  diagnostics,
  alerts,
  diagnosticsError,
  alertError,
  latestFlow,
  flowError,
  flowDraft,
  selectedStepId,
  stepEvidence,
  evidenceTimeline,
  evidenceTimelineError,
  resumeWithPreconditions,
  stepEvidenceError,
  onFlowDraftChange,
  onSelectStep,
  onResumeWithPreconditionsChange,
  onSaveFlowDraft,
  onPromoteTemplate,
  onReplayLatestFlow,
  onReplayStep,
  onResumeFromStep,
  onRefresh,
}: FlowWorkshopViewProps) {
  const hasDraftSteps = Boolean(flowDraft && flowDraft.steps.length > 0);
  const hasLatestSession = Boolean(latestFlow?.session_id);
  const hasEvidence = evidenceTimeline.length > 0;
  const failedStep = evidenceTimeline.find((item) => !item.ok);
  const latestResultText = !hasEvidence
    ? pickUiText(locale, "Not run yet", "尚未运行")
    : failedStep
      ? pickUiText(locale, `Failed at ${failedStep.step_id}`, `失败于 ${failedStep.step_id}`)
      : pickUiText(locale, "Passed", "已通过");
  const nextActionText = !hasDraftSteps
    ? pickUiText(
        locale,
        "Run a browser experiment from Stress Lab first to generate an editable flow draft.",
        "请先从 Stress Lab 发起一次浏览器实验，生成可编辑的 flow 草稿。",
      )
    : !hasLatestSession
      ? pickUiText(
          locale,
          "Save the draft first, then replay the latest flow to complete the first end-to-end run.",
          "请先保存草稿，再重放最新 flow，完成第一次端到端运行。",
        )
      : failedStep
        ? pickUiText(
            locale,
            `Resume from ${failedStep.step_id} and fix that step before retrying.`,
            `请从 ${failedStep.step_id} 继续，先修掉这个步骤，再重新尝试。`,
          )
        : pickUiText(
            locale,
            "Review the key screenshots and reuse the flow with confidence.",
            "先查看关键截图，再更有把握地复用这条流程。",
          );

  return (
    <div
      className="flow-workshop-view"
      id="app-view-workshop-panel"
      role="tabpanel"
      aria-labelledby="console-tab-workshop"
    >
      {/* Left: Diagnostics + Flow Editor */}
      <div className="flow-editor-column" data-testid={FLOW_WORKSHOP_EDITOR_COLUMN_TEST_ID}>
        <Card className="workshop-focus-card">
          <CardHeader>
            <CardTitle as="h2">
              {pickUiText(locale, "Lab result and next experiment", "实验结果与下一次实验")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="workshop-advanced-note">
              {pickUiText(
                locale,
                "Flow Studio is the deeper lab area. Use it after the first experiment when you need to inspect the journey, replay steps, or tighten the next pass.",
                "Flow Studio 是更深一层的实验区。第一次实验之后，如果你要检查流程、重放步骤或继续收紧下一轮实验，就来这里。",
              )}
            </p>
            <div className="focus-kpis">
              <div className="focus-kpi">
                <span className="focus-kpi-label">{pickUiText(locale, "Draft", "草稿")}</span>
                <span className="focus-kpi-value">
                  {hasDraftSteps
                    ? pickUiText(locale, "Ready", "已就绪")
                    : pickUiText(locale, "Missing", "缺失")}
                </span>
              </div>
              <div className="focus-kpi">
                <span className="focus-kpi-label">{pickUiText(locale, "Latest replay", "最新重放")}</span>
                <span className="focus-kpi-value">{latestResultText}</span>
              </div>
            </div>
            <p className="hint-text mt-2">{nextActionText}</p>
            <div className="form-actions mt-2">
              <Button size="sm" onClick={onSaveFlowDraft} disabled={!hasDraftSteps}>
                {pickUiText(locale, "Save draft", "保存草稿")}
              </Button>
              <Button variant="outline" size="sm" onClick={onPromoteTemplate} disabled={!hasDraftSteps}>
                {pickUiText(locale, "Promote to template", "提升为模板")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onReplayLatestFlow}
                disabled={!hasLatestSession}
              >
                {pickUiText(locale, "Replay latest flow", "重放最新 flow")}
              </Button>
              {failedStep && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onResumeFromStep(failedStep.step_id)}
                >
                  {pickUiText(
                    locale,
                    `Resume from ${failedStep.step_id}`,
                    `从 ${failedStep.step_id} 继续`,
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardHeader>
            <CardTitle>{pickUiText(locale, "Lab report lenses", "实验报告视角")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">
              {pickUiText(
                locale,
                "This product now treats browser testing like a lab. Different experiment types produce different result lenses: exploration, load, performance, resilience, visual drift, and accessibility.",
                "这个产品现在把浏览器测试当成实验室来做。不同实验类型会产出不同结果视角：探索、负载、性能、韧性、视觉漂移与无障碍。",
              )}
            </p>
            <ul
              className="task-list mt-3"
              aria-label={pickUiText(locale, "Lab report lenses", "实验报告视角")}
            >
              <li className="task-item">
                <div className="task-item-info text-left">
                  <strong>{pickUiText(locale, "Explore / Flow", "探索 / 流程")}</strong>
                  <p>
                    {pickUiText(
                      locale,
                      "State discovery, replay checkpoints, and path coverage for the current browser journey.",
                      "用于查看当前浏览器流程的状态发现、重放检查点和路径覆盖情况。",
                    )}
                  </p>
                </div>
              </li>
              <li className="task-item">
                <div className="task-item-info text-left">
                  <strong>{pickUiText(locale, "Load / Resilience", "负载 / 韧性")}</strong>
                  <p>
                    {pickUiText(
                      locale,
                      "Latency, failed requests, and fragile behaviour under pressure or noisy interaction.",
                      "用于查看高压或噪声交互下的延迟、失败请求和脆弱行为。",
                    )}
                  </p>
                </div>
              </li>
              <li className="task-item">
                <div className="task-item-info text-left">
                  <strong>
                    {pickUiText(locale, "Performance / Visual / Accessibility", "性能 / 视觉 / 无障碍")}
                  </strong>
                  <p>
                    {pickUiText(
                      locale,
                      "Page-speed signals, visual regressions, and serious accessibility issues for the same target.",
                      "用于查看同一目标上的页面速度信号、视觉回归和严重无障碍问题。",
                    )}
                  </p>
                </div>
              </li>
            </ul>
          </CardContent>
        </Card>

        <details className="workshop-advanced-panel">
          <summary>
            {pickUiText(
              locale,
              "Advanced studio (optional): diagnostics, flow editing, and debugging evidence",
              "高级工作台（可选）：诊断、流程编辑与调试证据",
            )}
          </summary>
          <div className="workshop-advanced-body">
            {/* Diagnostic Metrics */}
            <Card>
              <CardHeader>
                <CardTitle>{pickUiText(locale, "System status", "系统状态")}</CardTitle>
                <Button variant="ghost" size="sm" onClick={onRefresh}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 2v6h-6" />
                    <path d="M3 12a9 9 0 0115-6.7L21 8" />
                    <path d="M3 22v-6h6" />
                    <path d="M21 12a9 9 0 01-15 6.7L3 16" />
                  </svg>
                  {pickUiText(locale, "Refresh", "刷新")}
                </Button>
              </CardHeader>
              <CardContent>
                {diagnosticsError && <p className="error-text">{diagnosticsError}</p>}
                {alertError && <p className="error-text">{alertError}</p>}
                {flowError && <p className="error-text">{flowError}</p>}
                <div className="metrics-grid">
                  <div className="metric-card">
                    <div className="metric-label">{pickUiText(locale, "Uptime", "运行时长")}</div>
                    <div className="metric-value">
                      {diagnostics ? `${Math.round(diagnostics.uptime_seconds / 60)}m` : "\u2014"}
                    </div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">{pickUiText(locale, "Total tasks", "任务总数")}</div>
                    <div className="metric-value">{diagnostics?.task_total ?? 0}</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">{pickUiText(locale, "Running", "运行中")}</div>
                    <div className="metric-value">{diagnostics?.task_counts.running ?? 0}</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">{pickUiText(locale, "Succeeded", "已成功")}</div>
                    <div className="metric-value">{diagnostics?.task_counts.success ?? 0}</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">{pickUiText(locale, "Failed", "已失败")}</div>
                    <div className="metric-value">{diagnostics?.task_counts.failed ?? 0}</div>
                  </div>
                  <div className={`metric-card ${alerts?.state === "degraded" ? "warn" : "ok"}`}>
                    <div className="metric-label">{pickUiText(locale, "Health", "健康度")}</div>
                    <div className="metric-value">
                      {alerts?.state === "ok"
                        ? pickUiText(locale, "Healthy", "健康")
                        : alerts?.state === "degraded"
                          ? pickUiText(locale, "Degraded", "降级")
                          : "\u2014"}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Latest flow preview */}
            <Card>
              <CardHeader>
                <CardTitle>{pickUiText(locale, "Latest flow", "最新 flow")}</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onReplayLatestFlow}
                  disabled={!hasLatestSession}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  {pickUiText(locale, "Replay", "重放")}
                </Button>
              </CardHeader>
              <CardContent>
                {latestFlow?.session_id ? (
                  <>
                    <p className="hint-text mb-2">
                      {pickUiText(
                        locale,
                        `Session #${latestFlow.session_id.slice(0, 8)} \u00B7 ${latestFlow.step_count} steps \u00B7 ${latestFlow.source_event_count} events`,
                        `会话 #${latestFlow.session_id.slice(0, 8)} \u00B7 ${latestFlow.step_count} 步 \u00B7 ${latestFlow.source_event_count} 个事件`,
                      )}
                    </p>
                    <ul
                      className="task-list vlist-flow"
                      aria-label={pickUiText(locale, "Latest flow steps", "最新 flow 步骤")}
                    >
                      {latestFlow.steps.slice(0, 10).map((step) => (
                        <li key={step.step_id} className="task-item">
                          <div className="task-item-info">
                            <strong>{`${step.step_id} \u00B7 ${step.action}`}</strong>
                            <p>
                              {step.url ||
                                step.selector ||
                                step.value_ref ||
                                pickUiText(locale, "No additional detail", "暂无更多细节")}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
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
                        <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
                      </svg>
                    }
                    title={pickUiText(locale, "No flow data yet", "还没有 flow 数据")}
                    description={pickUiText(
                      locale,
                      "Run a recording once and the latest flow will appear here automatically.",
                      "先运行一次录制，最新 flow 就会自动出现在这里。",
                    )}
                  />
                )}
              </CardContent>
            </Card>

            {/* Flow draft editor */}
            <Card>
              <CardHeader>
                <CardTitle>{pickUiText(locale, "Flow editor", "流程编辑器")}</CardTitle>
              </CardHeader>
              <CardContent>
                <FlowDraftEditor
                  draft={flowDraft}
                  locale={locale}
                  selectedStepId={selectedStepId}
                  onSelectStep={onSelectStep}
                  onChange={onFlowDraftChange}
                  onSave={onSaveFlowDraft}
                  onRunStep={onReplayStep}
                  onResumeFromStep={onResumeFromStep}
                />
                <div className="form-row mt-2">
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={resumeWithPreconditions}
                      onChange={(e) => onResumeWithPreconditionsChange(e.target.checked)}
                    />
                    {pickUiText(
                      locale,
                      "Replay prerequisite wait conditions when resuming from a checkpoint",
                      "从检查点恢复时，重放前置等待条件",
                    )}
                  </label>
                </div>
              </CardContent>
            </Card>
          </div>
        </details>
      </div>

      {/* Right: Evidence */}
      <div className="flow-evidence-column">
        {stepEvidenceError && <p className="error-text">{stepEvidenceError}</p>}
        <details className="workshop-advanced-panel">
          <summary>
            {pickUiText(
              locale,
              "Advanced debugging evidence (optional)",
              "高级调试证据（可选）",
            )}
          </summary>
          <div className="workshop-advanced-body">
            {/* Evidence Timeline */}
            <div>
              <h3 className="section-title">{pickUiText(locale, "Evidence timeline", "证据时间线")}</h3>
              {evidenceTimelineError && <p className="error-text">{evidenceTimelineError}</p>}
              {evidenceTimeline.length === 0 ? (
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
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                  }
                  title={pickUiText(locale, "No evidence screenshots yet", "还没有证据截图")}
                  description={pickUiText(
                    locale,
                    "Replay the flow to populate before/after screenshots for each step.",
                    "请重放流程，为每一步生成前后截图。",
                  )}
                />
              ) : (
                <ul
                  className="task-list vlist-lg"
                  aria-label={pickUiText(locale, "Evidence timeline", "证据时间线")}
                >
                  {evidenceTimeline.map((item) => (
                    <li key={item.step_id}>
                      <button
                        type="button"
                        className={`task-item task-item-button flex-col ${selectedStepId === item.step_id ? "active" : ""}`}
                        aria-current={selectedStepId === item.step_id ? "step" : undefined}
                        onClick={() => onSelectStep(item.step_id)}
                      >
                        <div className="flex-row justify-between gap-2">
                          <strong>
                            {`${item.step_id} \u00B7 ${item.action ?? pickUiText(locale, "Unknown", "未知")}`}
                          </strong>
                          <Badge variant={item.ok ? "default" : "destructive"}>
                            {pickUiText(
                              locale,
                              `${item.ok ? "Passed" : "Failed"} \u00B7 ${item.duration_ms ?? 0}ms`,
                              `${item.ok ? "通过" : "失败"} \u00B7 ${item.duration_ms ?? 0}ms`,
                            )}
                          </Badge>
                        </div>
                        <p className="hint-text">
                          {item.detail ?? pickUiText(locale, "No additional detail", "暂无更多细节")}
                        </p>
                        <EvidenceScreenshotPair
                          locale={locale}
                          beforeImageUrl={item.screenshot_before_data_url}
                          afterImageUrl={item.screenshot_after_data_url}
                          beforeAlt={pickUiText(
                            locale,
                            `Before execution - ${item.step_id}`,
                            `执行前 - ${item.step_id}`,
                          )}
                          afterAlt={pickUiText(
                            locale,
                            `After execution - ${item.step_id}`,
                            `执行后 - ${item.step_id}`,
                          )}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Step Evidence Detail */}
            <div>
              <h3 className="section-title">
                {pickUiText(locale, "Step evidence details", "步骤证据详情")}
              </h3>
              {!selectedStepId ? (
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
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  }
                  title={pickUiText(locale, "Select a step to inspect evidence", "选择一个步骤查看证据")}
                  description={pickUiText(
                    locale,
                    "Choose a step from the timeline or editor to view detailed evidence.",
                    "请从时间线或编辑器中选择一个步骤，查看详细证据。",
                  )}
                />
              ) : !stepEvidence ? (
                <p className="hint-text p-4">
                  {pickUiText(
                    locale,
                    `Step ${selectedStepId} has no evidence yet. Run or replay it first.`,
                    `步骤 ${selectedStepId} 还没有证据。请先运行或重放它。`,
                  )}
                </p>
              ) : (
                <div className="card-raised">
                  <div className="field-group">
                    <div className="form-row">
                      <div className="field">
                        <span className="field-label">{pickUiText(locale, "Step", "步骤")}</span>
                        <span className="text-sm">
                          {`${stepEvidence.step_id} \u00B7 ${stepEvidence.action ?? pickUiText(locale, "Unknown", "未知")}`}
                        </span>
                      </div>
                      <div className="field">
                        <span className="field-label">{pickUiText(locale, "Status", "状态")}</span>
                        <span className="text-sm">
                          {stepEvidence.ok ? pickUiText(locale, "Passed", "通过") : pickUiText(locale, "Failed", "失败")}
                        </span>
                      </div>
                      <div className="field">
                        <span className="field-label">{pickUiText(locale, "Duration", "耗时")}</span>
                        <span className="text-sm">{`${stepEvidence.duration_ms ?? 0}ms`}</span>
                      </div>
                    </div>
                    <div className="field">
                      <span className="field-label">{pickUiText(locale, "Matched selector", "命中 selector")}</span>
                      <span className="hint-text">
                        {`[${stepEvidence.selector_index ?? "-"}] ${stepEvidence.matched_selector ?? pickUiText(locale, "None", "无")}`}
                      </span>
                    </div>
                    {stepEvidence.detail && (
                      <div className="field">
                        <span className="field-label">{pickUiText(locale, "Detail", "详情")}</span>
                        <span className="hint-text">{stepEvidence.detail}</span>
                      </div>
                    )}
                    <EvidenceScreenshotPair
                      locale={locale}
                      beforeImageUrl={stepEvidence.screenshot_before_data_url}
                      afterImageUrl={stepEvidence.screenshot_after_data_url}
                      beforeAlt={pickUiText(
                        locale,
                        `Evidence before execution - ${stepEvidence.step_id}`,
                        `执行前证据 - ${stepEvidence.step_id}`,
                      )}
                      afterAlt={pickUiText(
                        locale,
                        `Evidence after execution - ${stepEvidence.step_id}`,
                        `执行后证据 - ${stepEvidence.step_id}`,
                      )}
                      emptyHint={pickUiText(
                        locale,
                        "No screenshot evidence for this step",
                        "这个步骤还没有截图证据",
                      )}
                    />
                    <details className="debug-disclosure">
                      <summary>
                        {pickUiText(
                          locale,
                          "Advanced debugging: selector fallback trail",
                          "高级调试：selector 回退轨迹",
                        )}
                      </summary>
                      <div className="debug-disclosure-body">
                        {stepEvidence.fallback_trail.length === 0 ? (
                          <p className="hint-text">
                            {pickUiText(
                              locale,
                              "No selector fallback was triggered for this step.",
                              "这个步骤没有触发 selector 回退。",
                            )}
                          </p>
                        ) : (
                          <ul
                            className="task-list vlist-sm"
                            aria-label={pickUiText(locale, "Selector fallback trail", "selector 回退轨迹")}
                          >
                            {stepEvidence.fallback_trail.map((attempt) => (
                              <li
                                key={`${attempt.selector_index}-${attempt.value}`}
                                className="task-item"
                              >
                                <div className="task-item-info">
                                  <strong>{`#${attempt.selector_index} [${attempt.kind}] ${attempt.normalized ?? attempt.value}`}</strong>
                                  <p>
                                    {attempt.success
                                      ? pickUiText(locale, "Matched successfully", "已成功命中")
                                      : pickUiText(
                                          locale,
                                          `Failed: ${attempt.error ?? "Unknown error"}`,
                                          `失败：${attempt.error ?? "未知错误"}`,
                                        )}
                                  </p>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  </div>
                </div>
              )}
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

export default memo(FlowWorkshopView);
