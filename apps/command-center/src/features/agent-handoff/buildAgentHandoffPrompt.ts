import type {
  ReleaseBrief,
  RunAiReviewProjection,
  SimilarFailureMatch,
  TargetFeasibility,
} from "../../types";
import type { UiLocale } from "../../i18n/uiLocale";
import { pickUiText } from "../../i18n/uiLocale";

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeTopFindings(aiReview: RunAiReviewProjection | null) {
  if (!aiReview) {
    return [];
  }
  return aiReview.findings.slice(0, 3).map((finding) => {
    const title =
      readString(finding.title) ??
      readString(finding.summary) ??
      readString(finding.message) ??
      readString(finding.id) ??
      "Unnamed finding";
    const severity = readString(finding.severity) ?? "unknown";
    const category =
      readString(finding.category) ??
      readString(finding.type) ??
      readString(finding.kind) ??
      "uncategorized";
    return { title, severity, category };
  });
}

function summarizeFailureMatches(matches: SimilarFailureMatch[]) {
  return matches.slice(0, 3).map((match) => {
    const metrics = match.summary?.metrics;
    const metricParts =
      metrics && typeof metrics === "object"
        ? Object.entries(metrics)
            .filter(([, value]) => value !== null && value !== undefined)
            .slice(0, 3)
            .map(([key, value]) => `${key}=${String(value)}`)
        : [];
    return {
      runId: match.run_id,
      whyMatched: match.why_matched,
      reasons: match.reason_codes.slice(0, 3),
      metricParts,
    };
  });
}

export function buildAgentHandoffPrompt(args: {
  locale: UiLocale;
  runId: string;
  releaseBrief: ReleaseBrief | null;
  aiReview: RunAiReviewProjection | null;
  similarFailures: SimilarFailureMatch[];
  feasibility: TargetFeasibility | null;
}) {
  const { locale, runId, releaseBrief, aiReview, similarFailures, feasibility } = args;
  const topFindings = summarizeTopFindings(aiReview);
  const similarMatches = summarizeFailureMatches(similarFailures);
  const recommendation =
    releaseBrief?.recommendation ?? pickUiText(locale, "not loaded", "\u5c1a\u672a\u52a0\u8f7d");
  const nextStep =
    releaseBrief?.next_step ?? pickUiText(locale, "load release brief first", "\u8bf7\u5148\u52a0\u8f7d release brief");
  const gateStatus = releaseBrief?.gate_status ?? pickUiText(locale, "unknown", "\u672a\u77e5");
  const aiInterpretation = releaseBrief?.ai_interpretation ?? {};
  const highOrAbove =
    readNumber(aiInterpretation.high_or_above) ??
    readNumber(aiReview?.summary?.highOrAbove) ??
    0;
  const findingsTotal =
    readNumber(aiInterpretation.findings_total) ??
    readNumber(aiReview?.summary?.totalFindings) ??
    aiReview?.findings.length ??
    0;
  const feasibilitySummary = feasibility
    ? feasibility.supported
      ? pickUiText(
          locale,
          `Supported on ${feasibility.target}; migration hints: ${
            feasibility.migration_hints.join(" | ") || "none"
          }.`,
          `\u5f53\u524d\u76ee\u6807 ${feasibility.target} \u53ef\u652f\u6301\uff1b\u8fc1\u79fb\u63d0\u793a\uff1a${
            feasibility.migration_hints.join(" | ") || "\u65e0"
          }\u3002`,
        )
      : pickUiText(
          locale,
          `Not ready for ${feasibility.target}; blocked reasons: ${
            feasibility.blocked_reasons.join(" | ") || "none"
          }.`,
          `\u5f53\u524d\u76ee\u6807 ${feasibility.target} \u8fd8\u4e0d\u9002\u914d\uff1b\u963b\u585e\u539f\u56e0\uff1a${
            feasibility.blocked_reasons.join(" | ") || "\u65e0"
          }\u3002`,
        )
    : pickUiText(
        locale,
        "No feasibility snapshot loaded yet.",
        "\u5c1a\u672a\u52a0\u8f7d feasibility \u5feb\u7167\u3002",
      );

  const lines = [
    pickUiText(
      locale,
      "You are helping with a governed Prooflane follow-up. Keep Stress Lab as the front door, treat AI/MCP/proof as deeper layers, and avoid inventing a second truth system.",
      "\u4f60\u6b63\u5728\u534f\u52a9\u4e00\u4e2a\u53d7\u6cbb\u7406\u7684 Prooflane \u8ddf\u8fdb\u4efb\u52a1\u3002\u8bf7\u4fdd\u6301 Stress Lab \u662f front door\uff0c\u628a AI/MCP/proof \u89c6\u4e3a deeper layer\uff0c\u4e0d\u8981\u53d1\u660e\u7b2c\u4e8c\u5957\u771f\u76f8\u7cfb\u7edf\u3002",
    ),
    "",
    pickUiText(locale, "Run context", "\u8fd0\u884c\u4e0a\u4e0b\u6587"),
    `- run_id: ${runId}`,
    `- gate_status: ${gateStatus}`,
    `- recommendation: ${recommendation}`,
    `- next_step: ${nextStep}`,
    `- ai_findings_total: ${findingsTotal}`,
    `- ai_high_or_above: ${highOrAbove}`,
    "",
    pickUiText(locale, "Top findings", "\u91cd\u70b9\u53d1\u73b0"),
    ...(topFindings.length > 0
      ? topFindings.map(
          (finding) =>
            `- ${finding.title} (${finding.severity} / ${finding.category})`,
        )
      : [pickUiText(locale, "- No AI findings loaded yet.", "- \u5c1a\u672a\u52a0\u8f7d AI findings\u3002")]),
    "",
    pickUiText(locale, "Similar historical failures", "\u5386\u53f2\u76f8\u4f3c\u5931\u8d25"),
    ...(similarMatches.length > 0
      ? similarMatches.map((match) => {
          const metricsSuffix =
            match.metricParts.length > 0 ? ` | metrics: ${match.metricParts.join(" \u00b7 ")}` : "";
          const reasonSuffix =
            match.reasons.length > 0 ? ` | reasons: ${match.reasons.join(", ")}` : "";
          return `- ${match.runId}: ${match.whyMatched}${reasonSuffix}${metricsSuffix}`;
        })
      : [pickUiText(locale, "- No similar failures loaded yet.", "- \u5c1a\u672a\u52a0\u8f7d\u76f8\u4f3c\u5931\u8d25\u3002")]),
    "",
    pickUiText(locale, "Feasibility snapshot", "Feasibility \u5feb\u7167"),
    `- ${feasibilitySummary}`,
    "",
    pickUiText(
      locale,
      "Requested output",
      "\u8f93\u51fa\u8981\u6c42",
    ),
    pickUiText(
      locale,
      "- Explain the highest-risk issue in plain language.",
      "- \u7528\u4eba\u8bdd\u89e3\u91ca\u5f53\u524d\u6700\u9ad8\u98ce\u9669\u95ee\u9898\u3002",
    ),
    pickUiText(
      locale,
      "- Recommend the next repo-side action before any platform or human escalation.",
      "- \u5148\u7ed9\u51fa repo-side \u4e0b\u4e00\u6b65\u52a8\u4f5c\uff0c\u518d\u8c08\u5e73\u53f0\u6216\u4eba\u5de5\u5347\u7ea7\u3002",
    ),
    pickUiText(
      locale,
      "- Keep wording truthful for Codex, Claude Code, and other MCP-capable clients; do not claim official partnerships.",
      "- \u9488\u5bf9 Codex\u3001Claude Code \u548c\u5176\u4ed6 MCP-capable clients \u4fdd\u6301 truthful wording\uff1b\u4e0d\u8981\u5047\u88c5\u5b98\u65b9\u5408\u4f5c\u3002",
    ),
  ];

  return lines.join("\n");
}
