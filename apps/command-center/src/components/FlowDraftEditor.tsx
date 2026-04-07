import { memo } from "react";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import type { FlowEditableDraft } from "../types";
import { Button, Card, CardContent } from "./ui";

interface FlowDraftEditorProps {
  draft: FlowEditableDraft | null;
  locale?: UiLocale;
  selectedStepId: string;
  onSelectStep: (stepId: string) => void;
  onChange: (next: FlowEditableDraft) => void;
  onSave: () => void;
  onRunStep: (stepId: string) => void;
  onResumeFromStep: (stepId: string) => void;
}

function FlowDraftEditor({
  draft,
  locale = DEFAULT_UI_LOCALE,
  selectedStepId,
  onSelectStep,
  onChange,
  onSave,
  onRunStep,
  onResumeFromStep,
}: FlowDraftEditorProps) {
  if (!draft) {
    return (
      <Card className="empty-state p-4">
        <CardContent>
          <p className="empty-state-desc">
            {pickUiText(
              locale,
              "No flow draft yet. Run a recording command first.",
              "还没有 flow 草稿。请先运行一次录制命令。",
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  const updateStartUrl = (value: string) => {
    onChange({ ...draft, start_url: value });
  };

  const updateStep = (index: number, patch: Partial<FlowEditableDraft["steps"][number]>) => {
    const nextSteps = draft.steps.map((step, idx) =>
      idx === index ? { ...step, ...patch } : step,
    );
    onChange({ ...draft, steps: nextSteps });
  };

  const removeStep = (index: number) => {
    const step = draft.steps[index];
    if (!step) {
      return;
    }
    const confirmed = window.confirm(
      pickUiText(
        locale,
        `Delete step "${step.step_id}"? This action cannot be undone.`,
        `确定删除步骤“${step.step_id}”吗？此操作无法撤销。`,
      ),
    );
    if (!confirmed) {
      return;
    }
    const nextSteps = draft.steps.filter((_, idx) => idx !== index);
    onChange({ ...draft, steps: nextSteps });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.steps.length) {
      return;
    }
    const nextSteps = [...draft.steps];
    const current = nextSteps[index];
    if (!current) {
      return;
    }
    nextSteps[index] = nextSteps[target];
    nextSteps[target] = current;
    onChange({ ...draft, steps: nextSteps });
  };

  const addStep = () => {
    const nextIndex = draft.steps.length + 1;
    onChange({
      ...draft,
      steps: [
        ...draft.steps,
        {
          step_id: `s${nextIndex}`,
          action: "click",
          selected_selector_index: 0,
          target: { selectors: [{ kind: "css", value: "body", score: 50 }] },
        },
      ],
    });
  };

  return (
    <div>
      <p className="hint-text mb-3">
        {pickUiText(
          locale,
          "Start with the core path. Step parameters and debugging fields stay inside collapsible sections so they do not interrupt the first run.",
          "先专注核心路径。步骤参数和调试字段放在可折叠区域里，避免打断第一次运行。",
        )}
      </p>
      <div className="field mb-3">
        <label className="field-label" htmlFor="flow-start-url">
          {pickUiText(locale, "Flow start URL", "流程起始 URL")}
        </label>
        <input
          id="flow-start-url"
          className="field-input"
          value={draft.start_url}
          onChange={(e) => updateStartUrl(e.target.value)}
        />
      </div>

      <div className="form-actions mb-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addStep}
          data-testid="flowworkshop-add-step"
        >
          {pickUiText(locale, "Add step", "添加步骤")}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onSave}
          data-testid="flowworkshop-save-draft"
        >
          {pickUiText(locale, "Save draft", "保存草稿")}
        </Button>
      </div>

      <ul className="task-list vlist-xl" aria-label="flow-editor-steps">
        {draft.steps.map((step, index) => {
          const selectors = step.target?.selectors ?? [];
          const selectedIndex = Math.max(
            0,
            Math.min(selectors.length - 1, step.selected_selector_index ?? 0),
          );
          return (
            <li
              key={`${step.step_id}-${index}`}
              className={`task-item flex-col ${selectedStepId === step.step_id ? "active" : ""}`}
            >
              <div className="flex-row justify-between gap-2 w-full">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-left"
                  aria-current={selectedStepId === step.step_id ? "true" : undefined}
                  onClick={() => onSelectStep(step.step_id)}
                  data-testid="flowworkshop-select-step"
                >
                  <strong>{`${step.step_id} \u00B7 ${step.action}`}</strong>
                </Button>
                <div className="step-primary-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onRunStep(step.step_id)}
                    data-testid="flowworkshop-run-step"
                  >
                    {pickUiText(locale, "Replay step", "重放步骤")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onResumeFromStep(step.step_id)}
                    data-testid="flowworkshop-resume-step"
                  >
                    {pickUiText(locale, "Resume", "继续")}
                  </Button>
                </div>
              </div>

              <details className="debug-disclosure mt-2">
                <summary>
                  {pickUiText(
                    locale,
                    "Step parameters (action / URL / value ref)",
                    "步骤参数（动作 / URL / 值引用）",
                  )}
                </summary>
                <div className="debug-disclosure-body">
                  <div className="form-row">
                    <select
                      className="field-select w-select-action"
                      value={step.action}
                      onChange={(e) => updateStep(index, { action: e.target.value })}
                      aria-label={`step-${index}-action`}
                    >
                      <option value="navigate">{"navigate"}</option>
                      <option value="click">{"click"}</option>
                      <option value="type">{"type"}</option>
                    </select>
                  </div>

                  {step.action === "navigate" && (
                    <input
                      className="field-input mt-2"
                      value={step.url ?? ""}
                      onChange={(e) => updateStep(index, { url: e.target.value })}
                      placeholder="https://example.com/path"
                      aria-label={`step-${index}-url`}
                    />
                  )}

                  {step.action === "type" && (
                    <input
                      className="field-input mt-2"
                      value={step.value_ref ?? ""}
                      onChange={(e) => updateStep(index, { value_ref: e.target.value })}
                      placeholder="${params.input}"
                      aria-label={`step-${index}-value-ref`}
                    />
                  )}
                </div>
              </details>

              <details className="debug-disclosure mt-2">
                <summary>
                  {pickUiText(
                    locale,
                    "Advanced settings (step_id / selector / order)",
                    "高级设置（step_id / selector / 顺序）",
                  )}
                </summary>
                <div className="debug-disclosure-body">
                  <div className="form-row">
                    <input
                      className="field-input flex-1"
                      value={step.step_id}
                      onChange={(e) => updateStep(index, { step_id: e.target.value })}
                      aria-label={`step-${index}-id`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => moveStep(index, -1)}
                      aria-label={pickUiText(locale, "Move up", "上移")}
                      data-testid="flowworkshop-move-step-up"
                    >
                      {"\u2191"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => moveStep(index, 1)}
                      aria-label={pickUiText(locale, "Move down", "下移")}
                      data-testid="flowworkshop-move-step-down"
                    >
                      {"\u2193"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      onClick={() => removeStep(index)}
                      aria-label={pickUiText(
                        locale,
                        `Delete step ${step.step_id}`,
                        `删除步骤 ${step.step_id}`,
                      )}
                      data-testid="flowworkshop-delete-step"
                    >
                      {"\u2715"}
                    </Button>
                  </div>
                  <select
                    className="field-select mt-2"
                    value={String(selectedIndex)}
                    onChange={(e) =>
                      updateStep(index, { selected_selector_index: Number(e.target.value) })
                    }
                    aria-label={`step-${index}-selector-index`}
                  >
                    {selectors.length === 0 ? (
                      <option value="0">{pickUiText(locale, "No selector", "无 selector")}</option>
                    ) : (
                      selectors.map((selector, selectorIndex) => (
                        <option key={`${selector.kind}-${selectorIndex}`} value={selectorIndex}>
                          {`${selectorIndex + 1}. [${selector.kind}] ${selector.value}`}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default memo(FlowDraftEditor);
