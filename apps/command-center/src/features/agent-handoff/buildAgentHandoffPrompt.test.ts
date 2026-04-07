import { describe, expect, it } from "vitest";
import { buildAgentHandoffPrompt } from "./buildAgentHandoffPrompt";

describe("buildAgentHandoffPrompt", () => {
  it("builds an english prompt with release, AI, and feasibility context", () => {
    const prompt = buildAgentHandoffPrompt({
      locale: "en",
      runId: "run-1",
      releaseBrief: {
        run_id: "run-1",
        recommendation: "investigate",
        gate_status: "failed",
        observed: {},
        ai_interpretation: { findings_total: 4, high_or_above: 2 },
        evidence_snapshot: {},
        open_questions: [],
        next_step: "Inspect the failed checks before rerunning.",
      },
      aiReview: {
        run_id: "run-1",
        enabled: true,
        findings: [{ title: "Flaky gate", severity: "high", category: "stability" }],
        summary: { totalFindings: 1, highOrAbove: 1 },
        generation: {},
      },
      similarFailures: [
        {
          run_id: "run-older",
          score: 0.91,
          reason_codes: ["gate.timeout"],
          summary: { metrics: { perfLcpMs: 2400 } },
          why_matched: "Shared timeout signature.",
        },
      ],
      feasibility: {
        template_id: "tpl-1",
        target: "web.local",
        supported: false,
        blocked_reasons: ["missing capability: network"],
        migration_hints: ["Use a target with network support."],
        required_capabilities: ["navigate"],
      },
    });

    expect(prompt).toContain("run_id: run-1");
    expect(prompt).toContain("Flaky gate");
    expect(prompt).toContain("Shared timeout signature.");
    expect(prompt).toContain("Not ready for web.local");
    expect(prompt).toContain("Codex, Claude Code");
  });

  it("builds a chinese prompt when locale is zh-CN", () => {
    const prompt = buildAgentHandoffPrompt({
      locale: "zh-CN",
      runId: "run-2",
      releaseBrief: null,
      aiReview: null,
      similarFailures: [],
      feasibility: null,
    });

    expect(prompt).toContain("\u4f60\u6b63\u5728\u534f\u52a9\u4e00\u4e2a\u53d7\u6cbb\u7406\u7684 Prooflane \u8ddf\u8fdb\u4efb\u52a1");
    expect(prompt).toContain("\u8fd0\u884c\u4e0a\u4e0b\u6587");
    expect(prompt).toContain("\u5c1a\u672a\u52a0\u8f7d");
  });
});
