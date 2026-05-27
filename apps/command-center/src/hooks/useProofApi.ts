import { useCallback } from "react";
import type {
  ProofCampaign,
  ProofCampaignDetail,
  ReleaseBrief,
  RunAiReviewProjection,
  RunCompareResult,
  SimilarFailuresResult,
  TargetFeasibility,
} from "../types";
import { buildApiUrl } from "./useApiClient";

type ProofApiClient = {
  listCampaigns: () => Promise<ProofCampaign[]>;
  getCampaign: (campaignId: string) => Promise<ProofCampaignDetail>;
  createCampaign: (payload: {
    model: string;
    name?: string | null;
    description?: string | null;
    run_ids: string[];
  }) => Promise<ProofCampaignDetail>;
  diffCampaigns: (
    campaignId: string,
    otherCampaignId: string,
  ) => Promise<{ diff: Record<string, unknown> }>;
  compareRuns: (leftRunId: string, rightRunId: string) => Promise<RunCompareResult>;
  getAiReview: (runId: string) => Promise<RunAiReviewProjection>;
  getReleaseBrief: (runId: string, baselineRunId?: string) => Promise<ReleaseBrief>;
  getSimilarFailures: (runId: string, limit?: number) => Promise<SimilarFailuresResult>;
  getTemplateFeasibility: (templateId: string, target: string) => Promise<TargetFeasibility>;
};

async function readJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(baseUrl, path), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      typeof payload?.detail === "string" ? payload.detail : `Request failed: ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

export function useProofApi(
  baseUrl: string,
  automationToken: string,
  automationClientId: string,
): ProofApiClient {
  const headers = useCallback((): HeadersInit => {
    const nextHeaders: Record<string, string> = {};
    if (automationToken.trim()) {
      nextHeaders["x-automation-token"] = automationToken.trim();
    }
    if (automationClientId.trim()) {
      nextHeaders["x-automation-client-id"] = automationClientId.trim();
    }
    return nextHeaders;
  }, [automationClientId, automationToken]);

  const listCampaigns = useCallback(async () => {
    const payload = await readJson<{ campaigns: ProofCampaign[] }>(baseUrl, "/api/proof/campaigns", {
      headers: headers(),
    });
    return payload.campaigns ?? [];
  }, [baseUrl, headers]);

  const getCampaign = useCallback(
    async (campaignId: string) =>
      readJson<ProofCampaignDetail>(
        baseUrl,
        `/api/proof/campaigns/${encodeURIComponent(campaignId)}`,
        { headers: headers() },
      ),
    [baseUrl, headers],
  );

  const createCampaign = useCallback(
    async (payload: { model: string; name?: string | null; description?: string | null; run_ids: string[] }) =>
      readJson<ProofCampaignDetail>(baseUrl, "/api/proof/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify(payload),
      }),
    [baseUrl, headers],
  );

  const diffCampaigns = useCallback(
    async (campaignId: string, otherCampaignId: string) =>
      readJson<{ diff: Record<string, unknown> }>(
        baseUrl,
        `/api/proof/campaigns/${encodeURIComponent(campaignId)}/diff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ other_campaign_id: otherCampaignId }),
        },
      ),
    [baseUrl, headers],
  );

  const compareRuns = useCallback(
    async (leftRunId: string, rightRunId: string) =>
      readJson<RunCompareResult>(baseUrl, "/api/proof/runs/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ left_run_id: leftRunId, right_run_id: rightRunId }),
      }),
    [baseUrl, headers],
  );

  const getAiReview = useCallback(
    async (runId: string) =>
      readJson<RunAiReviewProjection>(
        baseUrl,
        `/api/proof/runs/${encodeURIComponent(runId)}/ai-review`,
        { headers: headers() },
      ),
    [baseUrl, headers],
  );

  const getReleaseBrief = useCallback(
    async (runId: string, baselineRunId?: string) => {
      const query = baselineRunId?.trim()
        ? `?baseline_run_id=${encodeURIComponent(baselineRunId)}`
        : "";
      return readJson<ReleaseBrief>(
        baseUrl,
        `/api/proof/runs/${encodeURIComponent(runId)}/release-brief${query}`,
        { headers: headers() },
      );
    },
    [baseUrl, headers],
  );

  const getSimilarFailures = useCallback(
    async (runId: string, limit = 5) =>
      readJson<SimilarFailuresResult>(
        baseUrl,
        `/api/proof/runs/${encodeURIComponent(runId)}/similar-failures?limit=${encodeURIComponent(String(limit))}`,
        { headers: headers() },
      ),
    [baseUrl, headers],
  );

  const getTemplateFeasibility = useCallback(
    async (templateId: string, target: string) =>
      readJson<TargetFeasibility>(
        baseUrl,
        `/api/proof/templates/${encodeURIComponent(templateId)}/feasibility?target=${encodeURIComponent(target)}`,
        { headers: headers() },
      ),
    [baseUrl, headers],
  );

  return {
    listCampaigns,
    getCampaign,
    createCampaign,
    diffCampaigns,
    compareRuns,
    getAiReview,
    getReleaseBrief,
    getSimilarFailures,
    getTemplateFeasibility,
  };
}
