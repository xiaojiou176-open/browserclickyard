import type {
  ReleaseBrief,
  RunAiReviewProjection,
  RunCompareResult,
  SimilarFailureMatch,
} from "../types";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";

export type ReviewInsight = {
  id: "gate" | "compare" | "ai" | "history" | "evidence";
  title: string;
  detail: string;
  priority: "urgent" | "next" | "context";
};

function readFindingCount(aiReview: RunAiReviewProjection | null): number {
  return aiReview?.findings.length ?? 0;
}

function readHighOrAbove(aiReview: RunAiReviewProjection | null): number {
  const summaryValue = aiReview?.summary?.highOrAbove;
  if (typeof summaryValue === "number" && Number.isFinite(summaryValue)) {
    return summaryValue;
  }
  return (aiReview?.findings ?? []).filter((finding) => {
    const severity = typeof finding.severity === "string" ? finding.severity.toLowerCase() : "";
    return severity === "critical" || severity === "high";
  }).length;
}

export function buildReviewInsights(input: {
  locale?: UiLocale;
  releaseBrief: ReleaseBrief | null;
  compareResult: RunCompareResult | null;
  aiReview: RunAiReviewProjection | null;
  similarFailures: SimilarFailureMatch[];
}): ReviewInsight[] {
  const insights: ReviewInsight[] = [];
  const {
    locale = DEFAULT_UI_LOCALE,
    releaseBrief,
    compareResult,
    aiReview,
    similarFailures,
  } = input;

  if (releaseBrief?.gate_status === "failed") {
    insights.push({
      id: "gate",
      title: pickUiText(locale, "Gate is still failing", "门禁仍未通过"),
      detail:
        releaseBrief.next_step ||
        pickUiText(
          locale,
          "Block promotion and inspect the failed evidence first.",
          "先阻止继续推进，并优先检查失败证据。",
        ),
      priority: "urgent",
    });
  }

  const addedFailures = compareResult?.checks.added_failed_or_blocked.length ?? 0;
  const persistedFailures = compareResult?.checks.persisted_failed_or_blocked.length ?? 0;
  if (addedFailures > 0 || persistedFailures > 0) {
    insights.push({
      id: "compare",
      title: pickUiText(locale, "Compare deltas need review", "对比差异需要复核"),
      detail: pickUiText(
        locale,
        `Added failed/blocked checks: ${addedFailures}. Persistent failed/blocked checks: ${persistedFailures}.`,
        `新增 failed/blocked 检查：${addedFailures}。持续失败或阻塞检查：${persistedFailures}。`,
      ),
      priority: addedFailures > 0 ? "urgent" : "next",
    });
  }

  const highOrAbove = readHighOrAbove(aiReview);
  const findingCount = readFindingCount(aiReview);
  if (findingCount > 0) {
    insights.push({
      id: "ai",
      title: pickUiText(locale, "AI findings are ready", "AI 发现已就绪"),
      detail:
        highOrAbove > 0
          ? pickUiText(
              locale,
              `${highOrAbove} high-severity finding(s) need operator attention before promotion.`,
              `当前有 ${highOrAbove} 个高严重度 AI 发现，提升前需要人工确认。`,
            )
          : pickUiText(
              locale,
              `${findingCount} AI finding(s) are available for review, but none are high-severity.`,
              `当前有 ${findingCount} 个 AI 发现可供复核，但没有高严重度项。`,
            ),
      priority: highOrAbove > 0 ? "urgent" : "next",
    });
  }

  if (similarFailures.length > 0) {
    const topMatch = similarFailures[0];
    insights.push({
      id: "history",
      title: pickUiText(locale, "Historical match found", "已找到历史相似案例"),
      detail: pickUiText(
        locale,
        `${topMatch.run_id} is the closest governed match. ${topMatch.why_matched}`,
        `${topMatch.run_id} 是当前最接近的治理匹配案例。${topMatch.why_matched}`,
      ),
      priority: "context",
    });
  }

  if ((releaseBrief?.open_questions ?? []).length > 0) {
    insights.push({
      id: "evidence",
      title: pickUiText(locale, "Evidence gaps remain", "仍有证据缺口"),
      detail: (releaseBrief?.open_questions ?? []).slice(0, 2).join(" | "),
      priority: "next",
    });
  }

  if (insights.length === 0) {
    insights.push({
      id: "evidence",
      title: pickUiText(locale, "No urgent blockers in the current brief", "当前摘要里没有紧急阻塞"),
      detail: pickUiText(
        locale,
        "Load a compare result, AI review, or similar-failure set when you want a deeper guided read.",
        "如果你想要更深的引导式阅读，请继续加载 compare result、AI review 或 similar-failure 集合。",
      ),
      priority: "context",
    });
  }

  return insights;
}
