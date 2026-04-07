import { describe, expect, it } from "vitest";
import { buildReviewInsights } from "./reviewInsights";

describe("buildReviewInsights", () => {
  it("surfaces urgent gate and compare insights first", () => {
    const insights = buildReviewInsights({
      releaseBrief: {
        run_id: "run-1",
        recommendation: "investigate",
        gate_status: "failed",
        observed: {},
        ai_interpretation: {},
        evidence_snapshot: {},
        open_questions: ["Need a baseline run."],
        next_step: "Inspect the failed gate before promotion.",
      },
      compareResult: {
        left_run_id: "run-a",
        right_run_id: "run-b",
        metrics_delta: { values: {} },
        checks: {
          added_failed_or_blocked: ["gate.one"],
          removed_failed_or_blocked: [],
          persisted_failed_or_blocked: ["gate.two"],
        },
        summary: {},
      },
      aiReview: {
        run_id: "run-1",
        enabled: true,
        findings: [{ severity: "high" }, { severity: "low" }],
        summary: {},
        generation: {},
      },
      similarFailures: [
        {
          run_id: "run-old",
          score: 0.91,
          reason_codes: ["gate.one"],
          summary: {},
          why_matched: "Shared failure reason.",
        },
      ],
    });

    expect(insights.map((item) => item.id)).toEqual(["gate", "compare", "ai", "history", "evidence"]);
    expect(insights[0]?.priority).toBe("urgent");
    expect(insights[1]?.detail).toContain("Added failed/blocked checks: 1");
  });

  it("localizes the insight copy for zh-CN", () => {
    const insights = buildReviewInsights({
      locale: "zh-CN",
      releaseBrief: {
        run_id: "run-1",
        recommendation: "investigate",
        gate_status: "failed",
        observed: {},
        ai_interpretation: {},
        evidence_snapshot: {},
        open_questions: [],
        next_step: "先检查失败证据。",
      },
      compareResult: null,
      aiReview: null,
      similarFailures: [],
    });

    expect(insights[0]?.title).toBe("门禁仍未通过");
  });

  it("returns a calm fallback when no review data is loaded yet", () => {
    const insights = buildReviewInsights({
      releaseBrief: null,
      compareResult: null,
      aiReview: null,
      similarFailures: [],
    });

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      id: "evidence",
      priority: "context",
    });
  });
});
