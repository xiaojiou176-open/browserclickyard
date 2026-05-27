/* @vitest-environment jsdom */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProofApi } from "./useProofApi";

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(payload), { ...init, headers });
}

describe("useProofApi", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderHarness(baseUrl: string, automationToken: string, automationClientId: string) {
    const { result } = renderHook(() => useProofApi(baseUrl, automationToken, automationClientId));
    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    return result.current;
  }

  it("calls canonical proof endpoints with auth headers and parses responses", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: String(init?.method ?? "GET"),
        headers,
        body: typeof init?.body === "string" ? init.body : null,
      });

      if (url.endsWith("/api/proof/campaigns") && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          createJsonResponse({
            campaigns: [{ campaign_id: "camp-1", name: "Campaign One", run_ids: ["run-a"] }],
          }),
        );
      }
      if (url.endsWith("/api/proof/campaigns") && init?.method === "POST") {
        return Promise.resolve(
          createJsonResponse({
            campaign: {
              campaign_id: "camp-1",
              name: "Campaign One",
              description: "release review",
              model: "gemini-3.1-pro",
              run_ids: ["run-a", "run-b"],
            },
            report: {},
          }),
        );
      }
      if (url.endsWith("/api/proof/campaigns/camp-1")) {
        return Promise.resolve(
          createJsonResponse({
            campaign: {
              campaign_id: "camp-1",
              name: "Campaign One",
              run_ids: ["run-a", "run-b"],
            },
            report: {},
          }),
        );
      }
      if (url.endsWith("/api/proof/campaigns/camp-1/diff")) {
        return Promise.resolve(createJsonResponse({ diff: { changed_runs: ["run-b"] } }));
      }
      if (url.endsWith("/api/proof/runs/compare")) {
        return Promise.resolve(
          createJsonResponse({
            left_run_id: "run-a",
            right_run_id: "run-b",
            same_template_family: true,
            metrics_delta: { values: {} },
            checks: {
              added_failed_or_blocked: [],
              removed_failed_or_blocked: [],
              persisted_failed_or_blocked: [],
            },
            summary: { changed_steps: 1 },
          }),
        );
      }
      if (url.endsWith("/api/proof/runs/run-a/ai-review")) {
        return Promise.resolve(
          createJsonResponse({
            run_id: "run-a",
            verdict: "pass",
            highlights: ["selector stable"],
          }),
        );
      }
      if (url.endsWith("/api/proof/runs/run-a/release-brief?baseline_run_id=run-b")) {
        return Promise.resolve(
          createJsonResponse({
            run_id: "run-a",
            baseline_run_id: "run-b",
            recommendation: "investigate",
            gate_status: "failed",
            observed: {},
            ai_interpretation: {},
            evidence_snapshot: {},
            open_questions: [],
            next_step: "Review the highest-risk evidence.",
          }),
        );
      }
      if (url.endsWith("/api/proof/runs/run-a/similar-failures?limit=3")) {
        return Promise.resolve(
          createJsonResponse({
            run_id: "run-a",
            matches: [
              {
                run_id: "run-z",
                score: 0.91,
                reason_codes: ["gate.perf_lcp_ms_max.failed.threshold_exceeded"],
                why_matched: "Shared failure reason.",
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/proof/templates/template%2F1/feasibility?target=ios%20sim")) {
        return Promise.resolve(
          createJsonResponse({
            template_id: "template/1",
            target: "ios sim",
            supported: true,
            blocked_reasons: [],
            migration_hints: [],
            required_capabilities: [],
          }),
        );
      }
      return Promise.resolve(
        createJsonResponse({ detail: `unexpected url: ${url}` }, { status: 404 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const proofApi = await renderHarness(
      "http://127.0.0.1:17380",
      "  token-123  ",
      " client-456 ",
    );

    await expect(proofApi.listCampaigns()).resolves.toMatchObject([
      expect.objectContaining({ campaign_id: "camp-1" }),
    ]);
    await expect(proofApi.getCampaign("camp-1")).resolves.toMatchObject({
      campaign: expect.objectContaining({ campaign_id: "camp-1" }),
    });
    await expect(
      proofApi.createCampaign({
        model: "gemini-3.1-pro",
        name: "Campaign One",
        description: "release review",
        run_ids: ["run-a", "run-b"],
      }),
    ).resolves.toMatchObject({ campaign: expect.objectContaining({ campaign_id: "camp-1" }) });
    await expect(proofApi.diffCampaigns("camp-1", "camp-2")).resolves.toEqual({
      diff: { changed_runs: ["run-b"] },
    });
    await expect(proofApi.compareRuns("run-a", "run-b")).resolves.toMatchObject({
      left_run_id: "run-a",
      right_run_id: "run-b",
    });
    await expect(proofApi.getAiReview("run-a")).resolves.toMatchObject({
      verdict: "pass",
    });
    await expect(proofApi.getReleaseBrief("run-a", "run-b")).resolves.toMatchObject({
      recommendation: "investigate",
    });
    await expect(proofApi.getSimilarFailures("run-a", 3)).resolves.toMatchObject({
      matches: [expect.objectContaining({ run_id: "run-z" })],
    });
    await expect(proofApi.getTemplateFeasibility("template/1", "ios sim")).resolves.toMatchObject({
      supported: true,
      target: "ios sim",
    });

    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(calls).toHaveLength(9);
    for (const call of calls) {
      expect(call.headers.get("x-automation-token")).toBe("token-123");
      expect(call.headers.get("x-automation-client-id")).toBe("client-456");
    }
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: "http://127.0.0.1:17380/api/proof/campaigns",
        method: "POST",
        body: JSON.stringify({
          model: "gemini-3.1-pro",
          name: "Campaign One",
          description: "release review",
          run_ids: ["run-a", "run-b"],
        }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: "http://127.0.0.1:17380/api/proof/campaigns/camp-1/diff",
        method: "POST",
        body: JSON.stringify({ other_campaign_id: "camp-2" }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: "http://127.0.0.1:17380/api/proof/runs/compare",
        method: "POST",
        body: JSON.stringify({ left_run_id: "run-a", right_run_id: "run-b" }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: "http://127.0.0.1:17380/api/proof/runs/run-a/release-brief?baseline_run_id=run-b",
        method: "GET",
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: "http://127.0.0.1:17380/api/proof/runs/run-a/similar-failures?limit=3",
        method: "GET",
      }),
    );
  });

  it("surfaces proof API errors and omits blank auth headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({ detail: "campaign missing" }, { status: 404, statusText: "Not Found" }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
        json: vi.fn().mockRejectedValue(new Error("invalid json")),
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const proofApi = await renderHarness("http://127.0.0.1:17380", "   ", " ");

    await expect(proofApi.getCampaign("camp-missing")).rejects.toThrow("campaign missing");
    await expect(proofApi.listCampaigns()).rejects.toThrow("Request failed: 500");

    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit | undefined]>) {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-automation-token")).toBeNull();
      expect(headers.get("x-automation-client-id")).toBeNull();
    }
  });
});
