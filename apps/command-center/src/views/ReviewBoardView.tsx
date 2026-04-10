import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "../components/ui";
import { buildAgentHandoffPrompt } from "../features/agent-handoff/buildAgentHandoffPrompt";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { formatFixedDecimal } from "../shared/locale";
import { buildReviewInsights } from "../shared/reviewInsights";
import {
  type ProofCampaign,
  type ProofCampaignDetail,
  type ReleaseBrief,
  type RunAiReviewProjection,
  type RunCompareResult,
  type SimilarFailureMatch,
  type TargetFeasibility,
  type UniversalRun,
  type UniversalTemplate,
} from "../types";
import { useProofApi } from "../hooks/useProofApi";

type ReviewBoardViewProps = {
  baseUrl: string;
  automationToken: string;
  automationClientId: string;
  locale?: UiLocale;
  runs: UniversalRun[];
  templates: UniversalTemplate[];
};

const REVIEW_BOARD_GUIDE =
  "Advanced Review is the optional governed compare layer. Start in Stress Lab, inspect the latest result in Runs & Blocks, and come here only when you need deeper comparison, proof bundles, or AI-assisted analysis.";

const REVIEW_TRUST_LADDER = [
  {
    key: "real-run",
    title: "Real run first",
    detail:
      "Do not start here from theory. Open Advanced Review only after Stress Lab and Runs & Blocks already surfaced a real result.",
  },
  {
    key: "governed-readback",
    title: "Read the gate before the story",
    detail:
      "Check gate status, compare deltas, and AI findings together so the operator reads one governed picture instead of scattered clues.",
  },
  {
    key: "handoff-ready",
    title: "Leave with a trusted next move",
    detail:
      "When the evidence is legible, end with a release brief or handoff prompt so the next operator inherits context instead of guesswork.",
  },
] as const;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecordNumber(record: Record<string, unknown> | undefined, key: string): number | null {
  if (!record) {
    return null;
  }
  return readNumber(record[key]);
}

function summarizeFindingSeverities(findings: Array<Record<string, unknown>>) {
  return findings.reduce(
    (acc, item) => {
      const severity = readString(item.severity)?.toLowerCase();
      if (severity === "critical") acc.critical += 1;
      else if (severity === "high") acc.high += 1;
      else if (severity === "medium") acc.medium += 1;
      else if (severity === "low") acc.low += 1;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
}

function summarizeFindingCategories(findings: Array<Record<string, unknown>>) {
  return findings.reduce<Record<string, number>>((acc, item) => {
    const category =
      readString(item.category) ??
      readString(item.type) ??
      readString(item.kind) ??
      "uncategorized";
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});
}

function describeFinding(finding: Record<string, unknown>): string {
  return (
    readString(finding.title) ??
    readString(finding.summary) ??
    readString(finding.message) ??
    readString(finding.id) ??
    "Unnamed finding"
  );
}

function describeFindingCategory(finding: Record<string, unknown>): string {
  return (
    readString(finding.category) ??
    readString(finding.type) ??
    readString(finding.kind) ??
    "uncategorized"
  );
}

function readSimilarFailureMetrics(
  match: SimilarFailureMatch,
  locale: UiLocale,
): Array<{ label: string; value: string }> {
  const metrics = match.summary?.metrics;
  if (!metrics || typeof metrics !== "object") {
    return [];
  }
  const labelMap: Record<string, string> = {
    a11ySerious: pickUiText(locale, "A11y serious", "\u4e25\u91cd\u65e0\u969c\u788d\u95ee\u9898"),
    perfLcpMs: "LCP",
    perfFcpMs: "FCP",
    loadFailedRequests: pickUiText(locale, "Failed requests", "\u5931\u8d25\u8bf7\u6c42"),
  };
  return Object.entries(metrics)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({
      label: labelMap[key] ?? key,
      value: String(value),
    }));
}

function localizeRunStatus(locale: UiLocale, status: UniversalRun["status"]): string {
  return pickUiText(
    locale,
    status,
    {
      queued: "排队中",
      running: "运行中",
      waiting_user: "等待人工输入",
      waiting_otp: "等待 OTP",
      success: "成功",
      failed: "失败",
      cancelled: "已取消",
    }[status],
  );
}

function localizeGateStatus(locale: UiLocale, status: string | null | undefined): string {
  const value = status ?? "not-loaded";
  return pickUiText(
    locale,
    value,
    {
      passed: "通过",
      failed: "失败",
      blocked: "阻塞",
      "not-loaded": "未加载",
    }[value] ?? value,
  );
}

function localizeSeverity(locale: UiLocale, value: string | null): string {
  const normalized = value?.toLowerCase() ?? "unknown";
  return pickUiText(
    locale,
    normalized,
    {
      critical: "严重",
      high: "高",
      medium: "中",
      low: "低",
      unknown: "未知",
    }[normalized] ?? normalized,
  );
}

export default function ReviewBoardView({
  baseUrl,
  automationToken,
  automationClientId,
  locale = DEFAULT_UI_LOCALE,
  runs,
  templates,
}: ReviewBoardViewProps) {
  const reviewBoardGuide = pickUiText(
    locale,
    REVIEW_BOARD_GUIDE,
    "Advanced Review \u662f\u53ef\u9009\u7684\u6df1\u5ea6\u6cbb\u7406\u5bf9\u6bd4\u5c42\u3002\u5148\u5728 Stress Lab \u53d1\u8d77\u5b9e\u9a8c\uff0c\u5728 Runs & Blocks \u770b\u61c2\u7ed3\u679c\uff0c\u53ea\u6709\u9700\u8981\u66f4\u6df1\u5bf9\u6bd4\u3001proof bundles \u6216 AI \u5206\u6790\u65f6\u624d\u6765\u8fd9\u91cc\u3002",
  );
  const proofApi = useProofApi(baseUrl, automationToken, automationClientId);
  const [campaigns, setCampaigns] = useState<ProofCampaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [selectedCampaign, setSelectedCampaign] = useState<ProofCampaignDetail | null>(null);
  const [compareCampaignId, setCompareCampaignId] = useState("");
  const [campaignDiff, setCampaignDiff] = useState<Record<string, unknown> | null>(null);
  const [campaignName, setCampaignName] = useState("release-candidate");
  const [campaignDescription, setCampaignDescription] = useState("");
  const [leftRunId, setLeftRunId] = useState("");
  const [rightRunId, setRightRunId] = useState("");
  const [compareResult, setCompareResult] = useState<RunCompareResult | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [aiReview, setAiReview] = useState<RunAiReviewProjection | null>(null);
  const [releaseBrief, setReleaseBrief] = useState<ReleaseBrief | null>(null);
  const [similarFailures, setSimilarFailures] = useState<SimilarFailureMatch[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("web.local");
  const [feasibility, setFeasibility] = useState<TargetFeasibility | null>(null);
  const [handoffCopyState, setHandoffCopyState] = useState<"idle" | "copied" | "unavailable">(
    "idle",
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const hasRuns = runs.length > 0;
  const hasTemplates = templates.length > 0;
  const hasCampaigns = campaigns.length > 0;
  const aiSeverity = useMemo(
    () => summarizeFindingSeverities(aiReview?.findings ?? []),
    [aiReview?.findings],
  );
  const aiCategories = useMemo(
    () => summarizeFindingCategories(aiReview?.findings ?? []),
    [aiReview?.findings],
  );
  const briefFindingsTotal = readRecordNumber(releaseBrief?.ai_interpretation, "findings_total");
  const briefHighOrAbove = readRecordNumber(releaseBrief?.ai_interpretation, "high_or_above");
  const aiHighOrAbove =
    readNumber(aiReview?.summary?.highOrAbove) ?? aiSeverity.critical + aiSeverity.high;
  const aiTotalFindings =
    readNumber(aiReview?.summary?.totalFindings) ?? aiReview?.findings.length ?? 0;
  const compareIssueCount =
    (compareResult?.checks.added_failed_or_blocked.length ?? 0) +
    (compareResult?.checks.persisted_failed_or_blocked.length ?? 0);
  const releaseBriefNextStep = useMemo(() => {
    if (releaseBrief) {
      return releaseBrief.next_step;
    }
    if (!compareResult && !aiReview) {
      return pickUiText(
        locale,
        "Load a run compare or AI review first. This brief becomes useful after review-ready evidence exists.",
        "请先加载一次运行对比或 AI 审查。只有存在可审查证据后，这份 brief 才真正有用。",
      );
    }
    if (compareResult?.right_gate_status === "failed") {
      return pickUiText(
        locale,
        "Block and investigate. The latest compared run still has a failed gate.",
        "先阻断、先排查。最新被对比的运行仍然存在失败门禁。",
      );
    }
    if (compareIssueCount > 0 || aiHighOrAbove > 0) {
      return pickUiText(
        locale,
        "Investigate before shipping. Review the failed checks and AI findings before you promote this candidate.",
        "发布前先排查。先看失败检查项和 AI 发现，再决定是否推进这个候选版本。",
      );
    }
    if (compareResult?.right_gate_status === "passed") {
      return pickUiText(
        locale,
        "Review-ready. The compared candidate is passing gates and no high-severity AI findings are visible in this brief.",
        "已经进入可复核状态。当前对比候选已通过门禁，而且这份 brief 里没有高严重度 AI 发现。",
      );
    }
    return pickUiText(
      locale,
      "Collect more evidence. This brief has partial signals, but not enough to support a clear release recommendation yet.",
      "还要补证据。当前 brief 只有部分信号，还不足以支撑明确的发布建议。",
    );
  }, [aiHighOrAbove, aiReview, compareIssueCount, compareResult, locale, releaseBrief]);
  const reviewInsights = useMemo(
    () =>
      buildReviewInsights({
        locale,
        releaseBrief,
        compareResult,
        aiReview,
        similarFailures,
      }),
    [aiReview, compareResult, locale, releaseBrief, similarFailures],
  );
  const handoffPrompt = useMemo(
    () =>
      buildAgentHandoffPrompt({
        locale,
        runId: selectedRunId || pickUiText(locale, "latest-run", "latest-run"),
        releaseBrief,
        aiReview,
        similarFailures,
        feasibility,
      }),
    [aiReview, feasibility, locale, releaseBrief, selectedRunId, similarFailures],
  );

  useEffect(() => {
    if (!leftRunId && runs[0]) {
      setLeftRunId(runs[0].run_id);
    }
    if (!rightRunId && runs[1]) {
      setRightRunId(runs[1].run_id);
    }
    if (!selectedRunId && runs[0]) {
      setSelectedRunId(runs[0].run_id);
    }
    if (!selectedTemplateId && templates[0]) {
      setSelectedTemplateId(templates[0].template_id);
    }
  }, [leftRunId, rightRunId, runs, selectedRunId, selectedTemplateId, templates]);

  const refreshCampaigns = useCallback(async () => {
    const nextCampaigns = await proofApi.listCampaigns();
    setCampaigns(nextCampaigns);
    if (!selectedCampaignId && nextCampaigns[0]) {
      setSelectedCampaignId(nextCampaigns[0].campaign_id);
    }
  }, [proofApi, selectedCampaignId]);

  useEffect(() => {
    void refreshCampaigns().catch((err: unknown) => {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Loading proof campaigns failed", "加载 proof campaigns 失败"),
      );
    });
  }, [locale, refreshCampaigns]);

  const loadCampaign = useCallback(async () => {
    if (!selectedCampaignId.trim()) {
      setSelectedCampaign(null);
      return;
    }
    const payload = await proofApi.getCampaign(selectedCampaignId);
    setSelectedCampaign(payload);
  }, [proofApi, selectedCampaignId]);

  useEffect(() => {
    void loadCampaign().catch((err: unknown) => {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Loading proof campaign failed", "加载 proof campaign 失败"),
      );
    });
  }, [loadCampaign, locale]);

  const handleCreateCampaign = useCallback(async () => {
    const runIds = [leftRunId, rightRunId].filter(Boolean);
    if (runIds.length === 0) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await proofApi.createCampaign({
        model: "models/gemini-3.1-pro-preview",
        name: campaignName,
        description: campaignDescription || null,
        run_ids: runIds,
      });
      setSelectedCampaignId(payload.campaign.campaign_id);
      setSelectedCampaign(payload);
      await refreshCampaigns();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Creating proof campaign failed", "创建 proof campaign 失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [campaignDescription, campaignName, leftRunId, locale, proofApi, refreshCampaigns, rightRunId]);

  const handleDiffCampaigns = useCallback(async () => {
    if (!selectedCampaignId || !compareCampaignId) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await proofApi.diffCampaigns(selectedCampaignId, compareCampaignId);
      setCampaignDiff(payload.diff);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Diffing proof campaigns failed", "比较 proof campaigns 失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [compareCampaignId, locale, proofApi, selectedCampaignId]);

  const handleCompare = useCallback(async () => {
    if (!leftRunId.trim() || !rightRunId.trim()) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await proofApi.compareRuns(leftRunId, rightRunId);
      setCompareResult(payload);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Comparing runs failed", "运行对比失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [leftRunId, locale, proofApi, rightRunId]);

  const handleLoadAiReview = useCallback(async () => {
    if (!selectedRunId.trim()) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await proofApi.getAiReview(selectedRunId);
      setAiReview(payload);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Loading AI review failed", "加载 AI 审查失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [locale, proofApi, selectedRunId]);

  const handleLoadReleaseBrief = useCallback(async () => {
    if (!selectedRunId.trim()) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const baselineRunId =
        rightRunId && selectedRunId === rightRunId && leftRunId && leftRunId !== rightRunId
          ? leftRunId
          : undefined;
      const payload = await proofApi.getReleaseBrief(selectedRunId, baselineRunId);
      setReleaseBrief(payload);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Loading release brief failed", "加载发布 brief 失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [leftRunId, locale, proofApi, rightRunId, selectedRunId]);

  const handleFindSimilarFailures = useCallback(async () => {
    if (!selectedRunId.trim()) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await proofApi.getSimilarFailures(selectedRunId, 5);
      setSimilarFailures(payload.matches);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Loading similar failures failed", "加载相似失败案例失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [locale, proofApi, selectedRunId]);

  const handleLoadFeasibility = useCallback(async () => {
    if (!selectedTemplateId.trim()) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await proofApi.getTemplateFeasibility(selectedTemplateId, selectedTarget);
      setFeasibility(payload);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : pickUiText(locale, "Loading target feasibility failed", "加载目标适配分析失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [locale, proofApi, selectedTarget, selectedTemplateId]);

  const handleCopyHandoff = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard-unavailable");
      }
      await navigator.clipboard.writeText(handoffPrompt);
      setHandoffCopyState("copied");
    } catch {
      setHandoffCopyState("unavailable");
    }
  }, [handoffPrompt]);

  return (
    <div
      className="flow-workshop-view"
      id="app-view-review-panel"
      role="tabpanel"
      aria-labelledby="console-tab-review"
    >
      <div className="flow-editor-column">
        <Card className="workshop-focus-card">
          <CardHeader>
            <CardTitle as="h2">{pickUiText(locale, "Advanced Review", "\u9ad8\u7ea7\u5ba1\u67e5")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">{reviewBoardGuide}</p>
            {error && (
              <p className="error-text mt-2" role="alert">
                {error}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardHeader>
            <CardTitle>{pickUiText(locale, "Review trust ladder", "审查信任阶梯")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">
              {pickUiText(
                locale,
                "Think of this page as the trust layer for operators: first prove the run is real, then read governed signals together, then leave with a clear next move.",
                "把这个页面理解成给操作员看的“信任层”：先确认 run 真实存在，再把治理信号放在一起读，最后带着明确的下一步离开。",
              )}
            </p>
            <div
              className="command-tags mt-2"
              aria-label={pickUiText(locale, "Review trust ladder", "审查信任阶梯")}
            >
              {REVIEW_TRUST_LADDER.map((step, index) => (
                <Badge key={step.key} variant="secondary">
                  {pickUiText(locale, `${index + 1}. ${step.title}`, `${index + 1}. ${
                    [
                      "先有真实 run",
                      "先读门禁再讲故事",
                      "离开时带着可信下一步",
                    ][index]
                  }`)}
                </Badge>
              ))}
            </div>
            <ul className="task-list mt-3">
              {REVIEW_TRUST_LADDER.map((step, index) => (
                <li key={step.key} className="task-item">
                  <div className="task-item-info text-left">
                    <strong>
                      {pickUiText(locale, `${index + 1}. ${step.title}`, `${index + 1}. ${
                        [
                          "先有真实 run",
                          "先读门禁再讲故事",
                          "离开时带着可信下一步",
                        ][index]
                      }`)}
                    </strong>
                    <p>
                      {pickUiText(
                        locale,
                        step.detail,
                        [
                          "不要从想象开始。只有当 Stress Lab 和 Runs & Blocks 已经给出真实结果后，才来这里做更深审查。",
                          "先把 gate、compare delta 和 AI 发现放在一起读，别让操作员在分散线索里拼图。",
                          "当证据已经看得懂时，用 release brief 或 handoff prompt 收尾，让下一位操作员接手时不用猜。",
                        ][index],
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardHeader>
            <CardTitle>{pickUiText(locale, "When to open this page", "\u4f55\u65f6\u6253\u5f00\u6b64\u9875")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">
              {pickUiText(
                locale,
                "Use this page after the experiment already produced a result. Stress Lab starts the run, Runs & Blocks confirms the latest outcome, and Advanced Review helps with governed comparison when the result needs deeper reading.",
                "\u53ea\u6709\u5f53\u5b9e\u9a8c\u5df2\u7ecf\u4ea7\u51fa\u7ed3\u679c\u65f6\uff0c\u624d\u5efa\u8bae\u6253\u5f00\u8fd9\u91cc\u3002Stress Lab \u8d1f\u8d23\u542f\u52a8\uff0cRuns & Blocks \u8d1f\u8d23\u786e\u8ba4\u6700\u65b0\u7ed3\u679c\uff0c\u800c Advanced Review \u8d1f\u8d23\u66f4\u6df1\u7684\u6cbb\u7406\u5bf9\u6bd4\u3002",
              )}
            </p>
            {!hasRuns && (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  "No experiment runs are ready yet. Start in Stress Lab first, then return here after Runs & Blocks shows a real result worth comparing.",
                  "当前还没有可用于比较的实验运行。请先在 Stress Lab 发起实验，等 Runs & Blocks 里出现值得比较的真实结果后再回来。",
                )}
              </p>
            )}
            {hasRuns && !hasCampaigns && (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  "You can compare runs as soon as they exist. Governed proof sets appear after you save a review set from those runs.",
                  "一旦 run 存在，你就可以开始比较。治理 proof set 会在你把这些 run 保存成 review set 之后出现。",
                )}
              </p>
            )}
            {!hasTemplates && (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  "Target feasibility needs at least one saved template. Once templates exist, this page can tell you whether a template can move across targets.",
                  "目标适配分析至少需要一个已保存模板。只要模板存在，这个页面就能告诉你它是否适合跨目标迁移。",
                )}
              </p>
            )}
            {error && (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  "If a data request fails here, first confirm the API is reachable and the latest runs are visible in Runs & Blocks. This page depends on those review-ready records.",
                  "如果这里的数据请求失败，请先确认 API 可访问，并且 Runs & Blocks 里能看到最新运行。这个页面依赖那些可供复核的记录。",
                )}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{pickUiText(locale, "Result comparison", "结果对比")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="field-group">
              <div className="field">
                <label className="field-label" htmlFor="review-left-run">
                  {pickUiText(locale, "Left run", "左侧运行")}
                </label>
                <select
                  id="review-left-run"
                  className="field-input"
                  value={leftRunId}
                  onChange={(event) => setLeftRunId(event.target.value)}
                >
                  {runs.map((run) => (
                    <option key={run.run_id} value={run.run_id}>
                      {`${run.run_id} \u00b7 ${run.status}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="review-right-run">
                  {pickUiText(locale, "Right run", "右侧运行")}
                </label>
                <select
                  id="review-right-run"
                  className="field-input"
                  value={rightRunId}
                  onChange={(event) => setRightRunId(event.target.value)}
                >
                  {runs.map((run) => (
                    <option key={run.run_id} value={run.run_id}>
                      {`${run.run_id} \u00b7 ${run.status}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-actions mt-2">
              <Button onClick={handleCompare} loading={loading} disabled={!leftRunId || !rightRunId}>
                {pickUiText(locale, "Compare runs", "比较运行")}
              </Button>
            </div>
            {compareResult && (
              <div className="mt-3">
                <div className="command-tags">
                  <Badge variant="secondary">
                    {pickUiText(
                      locale,
                      `left=${compareResult.left_gate_status ?? "unknown"}`,
                      `左侧=${compareResult.left_gate_status ?? "未知"}`,
                    )}
                  </Badge>
                  <Badge variant="secondary">
                    {pickUiText(
                      locale,
                      `right=${compareResult.right_gate_status ?? "unknown"}`,
                      `右侧=${compareResult.right_gate_status ?? "未知"}`,
                    )}
                  </Badge>
                </div>
                <p className="hint-text mt-2">
                  {pickUiText(
                    locale,
                    `Added failed/blocked: ${compareResult.checks.added_failed_or_blocked.join(", ") || "none"}`,
                    `新增 failed/blocked：${compareResult.checks.added_failed_or_blocked.join("，") || "无"}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Removed failed/blocked: ${compareResult.checks.removed_failed_or_blocked.join(", ") || "none"}`,
                    `移除的 failed/blocked：${compareResult.checks.removed_failed_or_blocked.join("，") || "无"}`,
                  )}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{pickUiText(locale, "Governed proof sets", "治理式 proof 集合")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="field-group">
              <div className="field">
                <label className="field-label" htmlFor="review-campaign-name">
                  {pickUiText(locale, "Campaign name", "Campaign 名称")}
                </label>
                <input
                  id="review-campaign-name"
                  className="field-input"
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="review-campaign-description">
                  {pickUiText(locale, "Campaign description", "Campaign 描述")}
                </label>
                <input
                  id="review-campaign-description"
                  className="field-input"
                  value={campaignDescription}
                  onChange={(event) => setCampaignDescription(event.target.value)}
                />
              </div>
            </div>
            <div className="form-actions mt-2">
              <Button onClick={handleCreateCampaign} loading={loading} disabled={!leftRunId && !rightRunId}>
                {pickUiText(locale, "Create campaign from selected runs", "用已选运行创建 campaign")}
              </Button>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="review-campaign">
                {pickUiText(locale, "Campaign", "Campaign")}
              </label>
              <select
                id="review-campaign"
                className="field-input"
                value={selectedCampaignId}
                onChange={(event) => setSelectedCampaignId(event.target.value)}
              >
                <option value="">{pickUiText(locale, "Select one campaign", "选择一个 campaign")}</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.campaign_id} value={campaign.campaign_id}>
                    {`${campaign.campaign_id} \u00b7 ${pickUiText(locale, campaign.status, campaign.status)}`}
                  </option>
                ))}
              </select>
            </div>
            {selectedCampaign && (
              <div className="mt-3">
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Campaign model: ${selectedCampaign.campaign.model}`,
                    `Campaign 模型：${selectedCampaign.campaign.model}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Run count: ${selectedCampaign.campaign.run_ids.length}`,
                    `运行数量：${selectedCampaign.campaign.run_ids.length}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Reason codes: ${selectedCampaign.campaign.reason_codes.join(", ") || "none"}`,
                    `原因代码：${selectedCampaign.campaign.reason_codes.join("，") || "无"}`,
                  )}
                </p>
                <div className="field mt-2">
                  <label className="field-label" htmlFor="review-campaign-diff">
                    {pickUiText(locale, "Compare against campaign", "与 campaign 对比")}
                  </label>
                  <select
                    id="review-campaign-diff"
                    className="field-input"
                    value={compareCampaignId}
                    onChange={(event) => setCompareCampaignId(event.target.value)}
                  >
                    <option value="">{pickUiText(locale, "Select another campaign", "选择另一个 campaign")}</option>
                    {campaigns
                      .filter((campaign) => campaign.campaign_id !== selectedCampaign.campaign.campaign_id)
                      .map((campaign) => (
                        <option key={campaign.campaign_id} value={campaign.campaign_id}>
                          {`${campaign.campaign_id} \u00b7 ${pickUiText(locale, campaign.status, campaign.status)}`}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="form-actions mt-2">
                  <Button
                    variant="outline"
                    onClick={handleDiffCampaigns}
                    loading={loading}
                    disabled={!compareCampaignId}
                  >
                    {pickUiText(locale, "Diff campaigns", "比较 campaigns")}
                  </Button>
                </div>
                {campaignDiff && (
                  <p className="hint-text mt-2">
                    {pickUiText(
                      locale,
                      `Campaign delta keys: ${Object.keys(campaignDiff).join(", ") || "none"}`,
                      `Campaign 差异键：${Object.keys(campaignDiff).join("，") || "无"}`,
                    )}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="task-detail-column">
        <Card>
          <CardHeader>
            <CardTitle>{pickUiText(locale, "AI release brief", "AI \u53d1\u5e03\u6458\u8981")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">
              {pickUiText(
                locale,
                "This brief is a reading layer over the same compare and AI-review data already in the system. It summarizes what is most worth checking before the next release decision.",
                "这份 brief 是已有 compare 和 AI-review 数据之上的阅读层，用来先总结下一次发布决策前最值得检查的内容。",
              )}
            </p>
            <p className="hint-text mt-2">{releaseBriefNextStep}</p>
            <div className="command-tags mt-2">
              <Badge variant="secondary">
                {pickUiText(
                  locale,
                  `gate=${releaseBrief?.gate_status ?? compareResult?.right_gate_status ?? "not-loaded"}`,
                  `门禁=${localizeGateStatus(
                    locale,
                    releaseBrief?.gate_status ?? compareResult?.right_gate_status ?? "not-loaded",
                  )}`,
                )}
              </Badge>
              <Badge variant="secondary">
                {pickUiText(locale, `compare-issues=${compareIssueCount}`, `对比问题=${compareIssueCount}`)}
              </Badge>
              <Badge variant="secondary">
                {pickUiText(
                  locale,
                  `ai-findings=${briefFindingsTotal ?? aiTotalFindings}`,
                  `AI 发现=${briefFindingsTotal ?? aiTotalFindings}`,
                )}
              </Badge>
              <Badge variant="secondary">
                {pickUiText(locale, `ai-high+=${briefHighOrAbove ?? aiHighOrAbove}`, `AI 高危+=${briefHighOrAbove ?? aiHighOrAbove}`)}
              </Badge>
            </div>
            <div className="mt-3">
              <p className="field-label">{pickUiText(locale, "Decision cues", "\u51b3\u7b56\u7ebf\u7d22")}</p>
              <ul
                className="task-list mt-2"
                aria-label={pickUiText(locale, "Review insights", "审查洞察")}
              >
                {reviewInsights.map((insight) => (
                  <li key={insight.id} className="task-item">
                    <div className="task-item-info text-left">
                      <strong>{insight.title}</strong>
                      <p>{insight.detail}</p>
                    </div>
                    <Badge
                      variant={
                        insight.priority === "urgent"
                          ? "destructive"
                          : insight.priority === "next"
                            ? "secondary"
                            : "secondary"
                      }
                    >
                      {pickUiText(
                        locale,
                        insight.priority,
                        insight.priority === "urgent"
                          ? "紧急"
                          : insight.priority === "next"
                            ? "下一步"
                            : "背景",
                      )}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
            <div className="form-actions mt-2">
              <Button onClick={handleLoadReleaseBrief} loading={loading} disabled={!selectedRunId}>
                {pickUiText(locale, "Load AI release brief", "\u52a0\u8f7d AI \u53d1\u5e03\u6458\u8981")}
              </Button>
              <Button
                variant="outline"
                onClick={handleFindSimilarFailures}
                loading={loading}
                disabled={!selectedRunId}
              >
                {pickUiText(locale, "Find similar past cases", "\u67e5\u627e\u76f8\u4f3c\u5386\u53f2\u6848\u4f8b")}
              </Button>
            </div>
            {releaseBrief && (
              <div className="mt-3">
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Recommendation: ${releaseBrief.recommendation}`,
                    `建议：${pickUiText(
                      locale,
                      releaseBrief.recommendation,
                      {
                        promote: "推进发布",
                        investigate: "先调查",
                        rerun: "先重跑",
                        hold: "先暂停",
                      }[releaseBrief.recommendation] ?? releaseBrief.recommendation,
                    )}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(locale, `Next step: ${releaseBrief.next_step}`, `下一步：${releaseBrief.next_step}`)}
                </p>
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `AI interpretation: ${briefFindingsTotal ?? 0} findings, ${briefHighOrAbove ?? 0} high or above.`,
                    `AI 解读：共 ${briefFindingsTotal ?? 0} 条发现，其中 ${briefHighOrAbove ?? 0} 条为高危及以上。`,
                  )}
                </p>
                {(releaseBrief.open_questions ?? []).length > 0 && (
                  <p className="hint-text">
                    {pickUiText(
                      locale,
                      `Open questions: ${(releaseBrief.open_questions ?? []).join(" | ")}`,
                      `开放问题：${(releaseBrief.open_questions ?? []).join(" | ")}`,
                    )}
                  </p>
                )}
              </div>
            )}
            {compareResult && (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  `Changed failed or blocked checks: ${compareResult.checks.added_failed_or_blocked.join(", ") || "none"}. Persistent failed or blocked checks: ${compareResult.checks.persisted_failed_or_blocked.join(", ") || "none"}.`,
                  `变化后的 failed/blocked 检查：${compareResult.checks.added_failed_or_blocked.join("，") || "无"}。持续存在的 failed/blocked 检查：${compareResult.checks.persisted_failed_or_blocked.join("，") || "无"}。`,
                )}
              </p>
            )}
            {aiReview?.enabled && (
              <p className="hint-text mt-2">
                {pickUiText(
                  locale,
                  `AI review is enabled for ${aiReview.run_id}. Critical: ${aiSeverity.critical}, high: ${aiSeverity.high}, medium: ${aiSeverity.medium}, low: ${aiSeverity.low}.`,
                  `AI 审查已为 ${aiReview.run_id} 启用。严重：${aiSeverity.critical}，高：${aiSeverity.high}，中：${aiSeverity.medium}，低：${aiSeverity.low}。`,
                )}
              </p>
            )}
            {similarFailures.length > 0 && (
              <div className="mt-3">
                <p className="field-label">
                  {pickUiText(locale, "Evidence retrieval", "\u8bc1\u636e\u68c0\u7d22")}
                </p>
                <p className="hint-text mt-2">
                  {pickUiText(
                    locale,
                    "These matches come from existing governed failure evidence. Use them as comparison points, not as a new truth source.",
                    "这些匹配来自现有的治理失败证据。请把它们当成比较参照，而不是新的真相来源。",
                  )}
                </p>
                <ul
                  className="task-list mt-2"
                  aria-label={pickUiText(locale, "Similar past cases", "相似历史案例")}
                >
                  {similarFailures.map((match) => (
                    <li key={match.run_id} className="task-item">
                      <div className="task-item-info text-left">
                        <strong>
                          {pickUiText(
                            locale,
                            `${match.run_id} · score ${formatFixedDecimal(match.score, locale, 2)}`,
                            `${match.run_id} · 分数 ${formatFixedDecimal(match.score, locale, 2)}`,
                          )}
                        </strong>
                        <p>{match.why_matched}</p>
                        <p>
                          {pickUiText(
                            locale,
                            `Reason codes: ${match.reason_codes.join(", ") || "none"}`,
                            `原因代码：${match.reason_codes.join("，") || "无"}`,
                          )}
                        </p>
                        {readSimilarFailureMetrics(match, locale).length > 0 && (
                          <p>
                            {pickUiText(
                              locale,
                              `Key metrics: ${readSimilarFailureMetrics(match, locale)
                                .map((item) => `${item.label}=${item.value}`)
                                .join(" · ")}`,
                              `关键指标：${readSimilarFailureMetrics(match, locale)
                                .map((item) => `${item.label}=${item.value}`)
                                .join(" · ")}`,
                            )}
                          </p>
                        )}
                        {match.report_path && (
                          <p>
                            {pickUiText(locale, `Report path: ${match.report_path}`, `报告路径：${match.report_path}`)}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardHeader>
            <CardTitle>{pickUiText(locale, "Agent handoff prompt", "Agent \u4ea4\u63a5\u63d0\u793a")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">
              {pickUiText(
                locale,
                "Use this copy-ready prompt when you want Codex, Claude Code, or another MCP-capable client to continue the same governed follow-up without losing the current run context.",
                "\u5f53\u4f60\u60f3\u628a\u540c\u4e00\u4e2a\u6cbb\u7406\u8ddf\u8fdb\u4efb\u52a1\u4ea4\u7ed9 Codex\u3001Claude Code \u6216\u5176\u4ed6 MCP-capable client \u65f6\uff0c\u7528\u8fd9\u6bb5\u53ef\u590d\u5236\u63d0\u793a\u4fdd\u6301\u5f53\u524d run \u4e0a\u4e0b\u6587\u4e0d\u4e22\u5931\u3002",
              )}
            </p>
            <textarea
              className="field-textarea mt-3"
              rows={12}
              readOnly
              aria-label={pickUiText(locale, "Agent handoff prompt", "Agent \u4ea4\u63a5\u63d0\u793a")}
              value={handoffPrompt}
            />
            <div className="form-actions mt-2">
              <Button size="sm" onClick={() => void handleCopyHandoff()}>
                {pickUiText(locale, "Copy handoff prompt", "\u590d\u5236\u4ea4\u63a5\u63d0\u793a")}
              </Button>
            </div>
            {handoffCopyState === "copied" && (
              <p className="hint-text mt-2" aria-live="polite">
                {pickUiText(
                  locale,
                  "Copied. Paste it into Codex, Claude Code, or another MCP-capable client.",
                  "\u5df2\u590d\u5236\u3002\u73b0\u5728\u53ef\u4ee5\u7c98\u8d34\u5230 Codex\u3001Claude Code \u6216\u5176\u4ed6 MCP-capable client\u3002",
                )}
              </p>
            )}
            {handoffCopyState === "unavailable" && (
              <p className="hint-text mt-2" aria-live="polite">
                {pickUiText(
                  locale,
                  "Clipboard access is unavailable in this environment. Select the prompt manually if you still want to paste it elsewhere.",
                  "\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u526a\u8d34\u677f\u3002\u82e5\u4ecd\u9700\u5916\u90e8\u7c98\u8d34\uff0c\u8bf7\u624b\u52a8\u9009\u4e2d\u8fd9\u6bb5\u63d0\u793a\u3002",
                )}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{pickUiText(locale, "AI review workbench", "AI \u5ba1\u67e5\u5de5\u4f5c\u53f0")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="field-group">
              <div className="field">
                <label className="field-label" htmlFor="review-ai-run">
                  {pickUiText(locale, "Run", "运行")}
                </label>
                <select
                  id="review-ai-run"
                  className="field-input"
                  value={selectedRunId}
                  onChange={(event) => setSelectedRunId(event.target.value)}
                >
                  {runs.map((run) => (
                    <option key={run.run_id} value={run.run_id}>
                      {`${run.run_id} \u00b7 ${localizeRunStatus(locale, run.status)}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-actions mt-2">
              <Button onClick={handleLoadAiReview} loading={loading} disabled={!selectedRunId}>
                {pickUiText(locale, "Load AI review", "\u52a0\u8f7d AI \u5ba1\u67e5")}
              </Button>
            </div>
            {aiReview && (
              <div className="mt-3">
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Enabled: ${aiReview.enabled ? "true" : "false"}`,
                    `已启用：${aiReview.enabled ? "是" : "否"}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(locale, `Findings: ${aiReview.findings.length}`, `发现数：${aiReview.findings.length}`)}
                </p>
                <p className="hint-text">
                  {pickUiText(locale, `Report path: ${aiReview.report_path ?? "none"}`, `报告路径：${aiReview.report_path ?? "无"}`)}
                </p>
                <div className="command-tags mt-2">
                  <Badge variant="secondary">{pickUiText(locale, `critical=${aiSeverity.critical}`, `严重=${aiSeverity.critical}`)}</Badge>
                  <Badge variant="secondary">{pickUiText(locale, `high=${aiSeverity.high}`, `高=${aiSeverity.high}`)}</Badge>
                  <Badge variant="secondary">{pickUiText(locale, `medium=${aiSeverity.medium}`, `中=${aiSeverity.medium}`)}</Badge>
                  <Badge variant="secondary">{pickUiText(locale, `low=${aiSeverity.low}`, `低=${aiSeverity.low}`)}</Badge>
                </div>
                {Object.keys(aiCategories).length > 0 && (
                  <div className="mt-3">
                    <p className="field-label">
                      {pickUiText(locale, "Finding groups", "\u95ee\u9898\u5206\u7ec4")}
                    </p>
                    <ul
                      className="task-list mt-2"
                      aria-label={pickUiText(locale, "AI review finding groups", "AI 审查问题分组")}
                    >
                      {Object.entries(aiCategories)
                        .sort((left, right) => right[1] - left[1])
                        .slice(0, 5)
                        .map(([category, count]) => (
                          <li key={category} className="task-item">
                            <div className="task-item-info text-left">
                              <strong>{category}</strong>
                              <p>{pickUiText(locale, `${count} finding(s)`, `${count} 条发现`)}</p>
                            </div>
                          </li>
                      ))}
                    </ul>
                  </div>
                )}
                {aiReview.findings.length > 0 && (
                  <div className="mt-3">
                    <p className="field-label">
                      {pickUiText(locale, "Top findings", "\u91cd\u70b9\u53d1\u73b0")}
                    </p>
                    <ul
                      className="task-list mt-2"
                      aria-label={pickUiText(locale, "AI review top findings", "AI 审查重点发现")}
                    >
                      {aiReview.findings.slice(0, 5).map((finding, index) => (
                        <li key={`${describeFinding(finding)}-${index}`} className="task-item">
                          <div className="task-item-info text-left">
                            <strong>{describeFinding(finding)}</strong>
                            <p>
                              {pickUiText(
                                locale,
                                `Severity: ${localizeSeverity(locale, readString(finding.severity))} · Group: ${describeFindingCategory(finding)}`,
                                `严重度：${localizeSeverity(locale, readString(finding.severity))} · 分组：${describeFindingCategory(finding)}`,
                              )}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardHeader>
            <CardTitle>{pickUiText(locale, "Cross-target feasibility advisor", "跨目标适配顾问")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="field-group">
              <div className="field">
                <label className="field-label" htmlFor="review-template">
                  {pickUiText(locale, "Template", "模板")}
                </label>
                <select
                  id="review-template"
                  className="field-input"
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                >
                  {templates.map((template) => (
                    <option key={template.template_id} value={template.template_id}>
                      {`${template.name} \u00b7 v${template.version ?? 1}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="review-target">
                  {pickUiText(locale, "Target", "目标")}
                </label>
                <select
                  id="review-target"
                  className="field-input"
                  value={selectedTarget}
                  onChange={(event) => setSelectedTarget(event.target.value)}
                >
                  <option value="web.local">{"web.local"}</option>
                  <option value="web.ci">{"web.ci"}</option>
                  <option value="tauri.macos">{"tauri.macos"}</option>
                  <option value="swift.macos">{"swift.macos"}</option>
                </select>
              </div>
            </div>
            <div className="form-actions mt-2">
              <Button
                onClick={handleLoadFeasibility}
                loading={loading}
                disabled={!selectedTemplateId}
              >
                {pickUiText(locale, "Check feasibility", "检查适配性")}
              </Button>
            </div>
            {feasibility && (
              <div className="mt-3">
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Supported: ${feasibility.supported ? "yes" : "no"}`,
                    `可支持：${feasibility.supported ? "是" : "否"}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Required capabilities: ${feasibility.required_capabilities.join(", ") || "none"}`,
                    `所需能力：${feasibility.required_capabilities.join("，") || "无"}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Blocked reasons: ${feasibility.blocked_reasons.join(" | ") || "none"}`,
                    `阻塞原因：${feasibility.blocked_reasons.join(" | ") || "无"}`,
                  )}
                </p>
                <p className="hint-text">
                  {pickUiText(
                    locale,
                    `Migration hints: ${feasibility.migration_hints.join(" | ") || "none"}`,
                    `迁移提示：${feasibility.migration_hints.join(" | ") || "无"}`,
                  )}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
