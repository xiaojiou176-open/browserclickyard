import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLOW_WORKSHOP_EDITOR_COLUMN_TEST_ID } from "../constants/testIds";
import type { FlowEditableDraft } from "../types";
import FlowWorkshopView from "./FlowWorkshopView";

const draft: FlowEditableDraft = {
  flow_id: "flow-001",
  session_id: "session-001",
  start_url: "https://example.com",
  generated_at: "2026-01-01T00:00:00Z",
  source_event_count: 1,
  steps: [],
};

describe("FlowWorkshopView accessibility contract", () => {
  it("exposes stable test anchor for editor column", () => {
    const html = renderToStaticMarkup(
      <FlowWorkshopView
        diagnostics={null}
        alerts={null}
        diagnosticsError=""
        alertError=""
        latestFlow={null}
        flowError=""
        flowDraft={draft}
        selectedStepId=""
        stepEvidence={null}
        evidenceTimeline={[]}
        evidenceTimelineError=""
        resumeWithPreconditions={false}
        stepEvidenceError=""
        onFlowDraftChange={() => {}}
        onSelectStep={() => {}}
        onResumeWithPreconditionsChange={() => {}}
        onSaveFlowDraft={() => {}}
        onReplayLatestFlow={() => {}}
        onReplayStep={() => {}}
        onResumeFromStep={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain(`data-testid="${FLOW_WORKSHOP_EDITOR_COLUMN_TEST_ID}"`);
    expect(html).toContain("System status");
  });

  it("renders evidence timeline items as keyboard-focusable buttons", () => {
    const html = renderToStaticMarkup(
      <FlowWorkshopView
        diagnostics={null}
        alerts={null}
        diagnosticsError=""
        alertError=""
        latestFlow={null}
        flowError=""
        flowDraft={draft}
        selectedStepId="step-1"
        stepEvidence={null}
        evidenceTimeline={[
          {
            step_id: "step-1",
            action: "click",
            ok: true,
            duration_ms: 120,
            detail: "Click the sign-in button",
            matched_selector: "#login-btn",
            selector_index: 0,
            screenshot_before_path: null,
            screenshot_after_path: null,
            screenshot_before_data_url: "",
            screenshot_after_data_url: "",
            fallback_trail: [],
          },
        ]}
        evidenceTimelineError=""
        resumeWithPreconditions={false}
        stepEvidenceError=""
        onFlowDraftChange={() => {}}
        onSelectStep={() => {}}
        onResumeWithPreconditionsChange={() => {}}
        onSaveFlowDraft={() => {}}
        onReplayLatestFlow={() => {}}
        onReplayStep={() => {}}
        onResumeFromStep={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain('class="task-item task-item-button flex-col active"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("<button");
  });

  it("renders the flow workshop shell in Chinese when locale is zh-CN", () => {
    const html = renderToStaticMarkup(
      <FlowWorkshopView
        locale="zh-CN"
        diagnostics={null}
        alerts={null}
        diagnosticsError=""
        alertError=""
        latestFlow={null}
        flowError=""
        flowDraft={draft}
        selectedStepId=""
        stepEvidence={null}
        evidenceTimeline={[]}
        evidenceTimelineError=""
        resumeWithPreconditions={false}
        stepEvidenceError=""
        onFlowDraftChange={() => {}}
        onSelectStep={() => {}}
        onResumeWithPreconditionsChange={() => {}}
        onSaveFlowDraft={() => {}}
        onPromoteTemplate={() => {}}
        onReplayLatestFlow={() => {}}
        onReplayStep={() => {}}
        onResumeFromStep={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain("实验结果与下一次实验");
    expect(html).toContain("实验报告视角");
    expect(html).toContain("系统状态");
    expect(html).toContain("流程编辑器");
  });
});
