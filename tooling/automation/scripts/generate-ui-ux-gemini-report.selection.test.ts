import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseRepresentativeResponse,
  type GeminiParallelResponseItem,
  mergeRepresentativeWithMinorityHighFindings,
  type ParsedGeminiResponse,
} from "./generate-ui-ux-gemini-report.js";

type Verdict = "pass" | "needs_attention" | "critical_issues";

function buildCandidate(
  index: number,
  verdict: Verdict,
  overallScore: number,
  highOrAbove: number,
): {
  index: number;
  parsed: ParsedGeminiResponse;
} {
  const findings: ParsedGeminiResponse["findings"] = Array.from(
    { length: highOrAbove },
    (_, findingIndex) => ({
      id: `f-${index}-${findingIndex}`,
      severity: findingIndex % 2 === 0 ? "high" : "critical",
      category: "ui" as const,
      reason_code: `ai.gemini.ui_ux.test.${index}.${findingIndex}`,
      title: "sample",
      diagnosis: "sample",
      recommendation: "sample",
      evidence: [],
    }),
  );

  return {
    index,
    parsed: {
      reason_code: `ai.gemini.ui_ux.test.${index}`,
      reason_codes: [`ai.gemini.ui_ux.test.${index}`],
      summary: {
        verdict,
        overall_score: overallScore,
      },
      findings,
    },
  };
}

test("chooseRepresentativeResponse favors majority verdict over a low-score outlier", () => {
  const candidates = [
    buildCandidate(0, "critical_issues", 20, 3),
    buildCandidate(1, "pass", 81, 0),
    buildCandidate(2, "pass", 79, 0),
    buildCandidate(3, "pass", 78, 0),
  ];

  const selected = chooseRepresentativeResponse(candidates);
  assert.equal(selected.parsed.summary.verdict, "pass");
  assert.equal(selected.parsed.summary.overall_score, 78);
});

test("chooseRepresentativeResponse breaks verdict ties conservatively", () => {
  const candidates = [
    buildCandidate(0, "pass", 84, 0),
    buildCandidate(1, "needs_attention", 70, 1),
  ];

  const selected = chooseRepresentativeResponse(candidates);
  assert.equal(selected.parsed.summary.verdict, "needs_attention");
  assert.equal(selected.parsed.summary.overall_score, 70);
});

test("chooseRepresentativeResponse keeps median-like score when all verdicts agree", () => {
  const candidates = [
    buildCandidate(0, "needs_attention", 52, 1),
    buildCandidate(1, "needs_attention", 50, 1),
    buildCandidate(2, "needs_attention", 48, 1),
    buildCandidate(3, "needs_attention", 12, 4),
    buildCandidate(4, "needs_attention", 51, 1),
  ];

  const selected = chooseRepresentativeResponse(candidates);
  assert.equal(selected.parsed.summary.overall_score, 50);
  assert.equal(selected.parsed.summary.verdict, "needs_attention");
});

test("mergeRepresentativeWithMinorityHighFindings appends repeated minority high signals", () => {
  const representative = buildCandidate(0, "pass", 83, 0);
  const candidates: GeminiParallelResponseItem[] = [
    {
      backend: "developer-api",
      ...representative,
    },
    {
      backend: "developer-api",
      ...buildCandidate(1, "pass", 82, 0),
      parsed: {
        ...buildCandidate(1, "pass", 82, 0).parsed,
        findings: [
          {
            id: "minority-high-signal",
            severity: "high",
            category: "ux",
            reason_code: "ai.gemini.ui_ux.shared.minority_high_signal",
            title: "shared high finding",
            diagnosis: "shared diagnosis",
            recommendation: "shared recommendation",
            evidence: [],
          },
        ],
      },
    },
    {
      backend: "vertex-ai",
      ...buildCandidate(2, "pass", 80, 0),
      parsed: {
        ...buildCandidate(2, "pass", 80, 0).parsed,
        findings: [
          {
            id: "minority-high-signal",
            severity: "high",
            category: "ux",
            reason_code: "ai.gemini.ui_ux.shared.minority_high_signal",
            title: "shared high finding",
            diagnosis: "shared diagnosis",
            recommendation: "shared recommendation",
            evidence: [],
          },
        ],
      },
    },
  ];

  const merged = mergeRepresentativeWithMinorityHighFindings(representative.parsed, candidates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.reason_code, "ai.gemini.ui_ux.shared.minority_high_signal");
  assert.equal(merged[0]?.severity, "high");
  assert.match(merged[0]?.diagnosis ?? "", /Minority high-severity signal observed in 2\/3/);
});

test("mergeRepresentativeWithMinorityHighFindings ignores one-off outliers", () => {
  const representative = buildCandidate(0, "pass", 83, 0);
  const candidates: GeminiParallelResponseItem[] = [
    {
      backend: "developer-api",
      ...representative,
    },
    {
      backend: "developer-api",
      ...buildCandidate(1, "pass", 82, 0),
      parsed: {
        ...buildCandidate(1, "pass", 82, 0).parsed,
        findings: [
          {
            id: "single-outlier",
            severity: "critical",
            category: "ui",
            reason_code: "ai.gemini.ui_ux.shared.single_outlier",
            title: "single outlier",
            diagnosis: "single outlier diagnosis",
            recommendation: "single outlier recommendation",
            evidence: [],
          },
        ],
      },
    },
  ];

  const merged = mergeRepresentativeWithMinorityHighFindings(representative.parsed, candidates);
  assert.equal(merged.length, 0);
});
