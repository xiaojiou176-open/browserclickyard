#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const HISTORY_PATH = resolve("configs/env/reduction-history.json");
const OUT_PATH = resolve(".runtime-cache/reports/env-reduction-trend.md");

function main() {
  const history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  const samples = Array.isArray(history?.samples) ? history.samples : [];
  const labels = samples.map((item) => String(item.date));
  const declared = samples.map((item) => Number(item.declared ?? 0));
  const unused = samples.map((item) => Number(item.declaredButUnused ?? 0));

  const lines = [];
  lines.push("# Env Reduction Trend");
  lines.push("");
  lines.push(`Updated at: \`${history?.updated_at ?? "unknown"}\``);
  lines.push("");
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push('  title "ENV Reduction Trend"');
  lines.push(`  x-axis [${labels.map((x) => `"${x}"`).join(", ")}]`);
  lines.push('  y-axis "count" 0 --> 300');
  lines.push(`  line "declared" [${declared.join(", ")}]`);
  lines.push(`  line "declaredButUnused" [${unused.join(", ")}]`);
  lines.push("```");
  lines.push("");
  lines.push(
    "| Date | Declared | Declared But Unused | Used But Undeclared | Deprecated Aliases |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const item of samples) {
    lines.push(
      `| ${item.date} | ${item.declared} | ${item.declaredButUnused} | ${item.usedButUndeclared} | ${item.deprecatedAliases} |`,
    );
  }
  lines.push("");

  writeFileSync(OUT_PATH, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`[env-trend] wrote ${OUT_PATH}\n`);
}

main();
