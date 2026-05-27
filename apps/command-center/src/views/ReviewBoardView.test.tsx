/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReviewBoardView from "./ReviewBoardView";

describe("ReviewBoardView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the advanced review shell and loads empty proof campaigns", async () => {
    expect.hasAssertions();
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/api/proof/campaigns")) {
        return new Response(JSON.stringify({ campaigns: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReviewBoardView
        baseUrl="http://127.0.0.1:17380"
        automationToken="test-token-0123456789"
        automationClientId="review-board-test"
        runs={[]}
        templates={[]}
      />,
    );

    await screen.findByText("Advanced Review");
    await screen.findByText("Review trust ladder");
    await screen.findByText("When to open this page");
    await screen.findByText("AI release brief");
    await screen.findByText("Agent handoff prompt");
    await screen.findByText("Result comparison");
    await screen.findByText("Governed proof sets");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("shows grouped AI findings and actionable similar failure details", async () => {
    expect.hasAssertions();
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/api/proof/campaigns")) {
        return new Response(JSON.stringify({ campaigns: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (input.includes("/ai-review")) {
        return new Response(
          JSON.stringify({
            run_id: "run-1",
            enabled: true,
            report_path: "reports/ai-review.json",
            findings: [
              { id: "f1", severity: "high", category: "stability", title: "Flaky gate" },
              { id: "f2", severity: "medium", category: "stability", title: "Slow page" },
              { id: "f3", severity: "critical", category: "security", title: "Leaked token" },
            ],
            summary: { totalFindings: 3, highOrAbove: 2 },
            generation: {},
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (input.includes("/similar-failures")) {
        return new Response(
          JSON.stringify({
            run_id: "run-1",
            matches: [
              {
                run_id: "run-older",
                score: 0.91,
                gate_status: "failed",
                reason_codes: ["gate.timeout"],
                summary: { metrics: { perfLcpMs: 2400, loadFailedRequests: 3 } },
                why_matched: "Shared failure reason.",
                report_path: "reports/summary.json",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (input.includes("/release-brief")) {
        return new Response(
          JSON.stringify({
            run_id: "run-1",
            recommendation: "investigate",
            gate_status: "failed",
            observed: {},
            ai_interpretation: { findings_total: 3, high_or_above: 2 },
            evidence_snapshot: {},
            open_questions: ["Compare against a safer baseline."],
            next_step: "Inspect the failed checks before rerunning.",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReviewBoardView
        baseUrl="http://127.0.0.1:17380"
        automationToken="test-token-0123456789"
        automationClientId="review-board-test"
        runs={[
          {
            run_id: "run-1",
            template_id: "tpl-1",
            status: "success",
            wait_context: null,
            step_cursor: 1,
            params: {},
            task_id: null,
            last_error: null,
            artifacts_ref: {},
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            logs: [],
          },
        ]}
        templates={[]}
      />,
    );

    await screen.findByText("Advanced Review");
    fireEvent.click(await screen.findByRole("button", { name: "Load AI release brief" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load AI review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Find similar past cases" }));

    expect(await screen.findByText("Decision cues")).toBeTruthy();
    expect(await screen.findByText("AI findings are ready")).toBeTruthy();
    expect(await screen.findByText("Historical match found")).toBeTruthy();
    expect(await screen.findByText("Finding groups")).toBeTruthy();
    expect(await screen.findByText("stability")).toBeTruthy();
    expect(await screen.findByText("security")).toBeTruthy();
    expect(await screen.findByText("Top findings")).toBeTruthy();
    expect(await screen.findByText("Flaky gate")).toBeTruthy();
    expect(await screen.findByText(/Key metrics: LCP=2400 \u00b7 Failed requests=3/)).toBeTruthy();
    expect(await screen.findByText("Report path: reports/summary.json")).toBeTruthy();
    const handoffPrompt = screen.getByLabelText("Agent handoff prompt") as HTMLTextAreaElement;
    expect(handoffPrompt.value).toContain("run_id: run-1");
    expect(handoffPrompt.value).toContain("Codex, Claude Code");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("renders the advanced review shell in Chinese and exposes the handoff prompt", async () => {
    expect.hasAssertions();
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/api/proof/campaigns")) {
        return new Response(JSON.stringify({ campaigns: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReviewBoardView
        baseUrl="http://127.0.0.1:17380"
        automationToken="test-token-0123456789"
        automationClientId="review-board-test"
        locale="zh-CN"
        runs={[]}
        templates={[]}
      />,
    );

    await screen.findByText("高级审查");
    await screen.findByText("审查信任阶梯");
    await screen.findByText("Agent 交接提示");
    expect(
      (screen.getByLabelText("Agent 交接提示") as HTMLTextAreaElement).value,
    ).toContain("你正在协助一个受治理的 Pagestress 跟进任务");
  });
});
