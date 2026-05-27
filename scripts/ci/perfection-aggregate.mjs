#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const baseDir = process.env.PERFECTION_ARTIFACT_DIR || ".runtime-cache/artifacts/perfection";
const roundsDir = path.resolve(root, baseDir);

function median(nums) {
  if (!nums.length) {
    return 0;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function pct(n) {
  return Number((n * 100).toFixed(2));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf-8"));
}

async function main() {
  const entries = await fs.readdir(roundsDir, { withFileTypes: true }).catch(() => []);
  const roundNames = entries
    .filter((e) => e.isDirectory() && /^round-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  const rounds = [];
  for (const name of roundNames) {
    const dir = path.join(roundsDir, name);
    const statusPath = path.join(dir, "status.json");
    if (!(await fs.stat(statusPath).catch(() => null))) {
      continue;
    }
    const status = await readJson(statusPath);
    rounds.push({ ...status, round_dir: dir, round_name: name });
  }

  const totalMs = rounds.map((r) => Number(r.total_duration_ms || 0));
  const baseline = totalMs[0] || 0;
  const subsequent = totalMs.slice(1);
  const subsequentP50 = median(subsequent);
  const p50DeltaRatio = baseline > 0 ? (subsequentP50 - baseline) / baseline : 0;

  const geminiPassCount = rounds.filter(
    (r) => String(r.gemini_functional_status || "").toLowerCase() === "pass",
  ).length;
  const allPassed = rounds.length > 0 && rounds.every((r) => r.round_passed === true);

  const perfTargetRatio = Number(process.env.PERFECTION_PERF_TARGET_RATIO || "-0.1");
  const allowBaselineOnly = process.env.PERFECTION_ALLOW_BASELINE_ONLY === "1";
  const requirePerfTarget = process.env.PERFECTION_REQUIRE_PERF_TARGET === "1";
  const performanceTargetMet =
    rounds.length >= 2 ? p50DeltaRatio <= perfTargetRatio : allowBaselineOnly;
  const qualityGatePassed = allPassed;

  const summary = {
    generated_at: new Date().toISOString(),
    artifact_dir: roundsDir,
    rounds_count: rounds.length,
    rounds,
    all_passed: allPassed,
    gemini_pass_rate: rounds.length ? pct(geminiPassCount / rounds.length) : 0,
    baseline_total_duration_ms: baseline,
    p50_round2_plus_total_duration_ms: subsequentP50,
    p50_delta_percent: pct(p50DeltaRatio),
    performance_target_ratio: perfTargetRatio,
    performance_target_met: performanceTargetMet,
    require_performance_target: requirePerfTarget,
    quality_gate_passed: qualityGatePassed,
    final_verdict:
      qualityGatePassed && (!requirePerfTarget || performanceTargetMet) ? "Perfect" : "Not Perfect",
  };

  const summaryPath = path.join(roundsDir, "summary.json");
  await fs.mkdir(roundsDir, { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

  const reportLines = [
    "# Perfection Loop Report",
    "",
    `- Generated: ${summary.generated_at}`,
    `- Rounds: ${summary.rounds_count}`,
    `- all_passed: ${summary.all_passed}`,
    `- quality_gate_passed: ${summary.quality_gate_passed}`,
    `- gemini_pass_rate: ${summary.gemini_pass_rate}%`,
    `- baseline_total_duration_ms: ${summary.baseline_total_duration_ms}`,
    `- p50_round2_plus_total_duration_ms: ${summary.p50_round2_plus_total_duration_ms}`,
    `- p50_delta_percent: ${summary.p50_delta_percent}%`,
    `- require_performance_target: ${summary.require_performance_target}`,
    `- performance_target_met: ${summary.performance_target_met}`,
    `- final_verdict: ${summary.final_verdict}`,
    "",
    "## Round Status",
  ];

  for (const r of rounds) {
    reportLines.push(
      `- ${r.round_name}: passed=${r.round_passed} total_ms=${r.total_duration_ms} gemini_status=${r.gemini_functional_status} reason=${r.reason || ""}`,
    );
  }

  const reportPath = path.join(roundsDir, "final-report.md");
  await fs.writeFile(reportPath, `${reportLines.join("\n")}\n`, "utf-8");

  if (!qualityGatePassed || (requirePerfTarget && !performanceTargetMet)) {
    process.exitCode = 1;
  }
}

main().catch((_error) => {
  process.exit(1);
});
