import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

type ContractVar = {
  name: string;
  section?: string;
  required?: boolean;
  sensitive?: boolean;
};

type Contract = {
  variables: ContractVar[];
};

const SECTION_OWNER: Record<string, { owner: string; module: string; doc: string }> = {
  core: {
    owner: "Backend Platform",
    module: "services/api/app/core",
    doc: "docs/reference/configuration.md",
  },
  auth: {
    owner: "Security & Platform",
    module: "services/api/app/core + services/api/app/services",
    doc: "docs/reference/configuration.md",
  },
  limits: {
    owner: "Runtime Reliability",
    module: "scripts/ci + services/api/app/core",
    doc: "docs/reference/runtime-storage-policy.md",
  },
  storage: {
    owner: "Data Platform",
    module: "services/api/app/core + services/api/tests",
    doc: "docs/reference/runtime-storage-policy.md",
  },
  runtime: {
    owner: "Automation Runtime",
    module: "scripts/* + tooling/automation/scripts/*",
    doc: "docs/reference/configuration.md",
  },
  mcp: {
    owner: "MCP Platform",
    module: "services/mcp-server/src",
    doc: "docs/reference/configuration.md",
  },
  frontend: {
    owner: "Frontend Platform",
    module: "frontend + tests/web-harness",
    doc: "docs/reference/configuration.md",
  },
  ai: {
    owner: "AI Infrastructure",
    module: "tooling/automation/scripts + scripts/ai + services/api/app/services",
    doc: "docs/reference/configuration.md",
  },
  tests: {
    owner: "QA Infrastructure",
    module: "tests + scripts/test-*",
    doc: "docs/reference/configuration.md",
  },
  otp: {
    owner: "Automation Runtime",
    module: "tooling/automation/scripts/lib/replay-flow-*",
    doc: "docs/reference/configuration.md",
  },
  vonage: {
    owner: "Communications Platform",
    module: "services/api/app/integrations + scripts/ci",
    doc: "docs/reference/configuration.md",
  },
};

function toSectionTitle(section: string): string {
  return section
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function main(): void {
  const contractPath = resolve("configs/env/contract.yaml");
  const outPath = resolve("docs/reference/env-owner-map.md");
  const parsed = YAML.parse(readFileSync(contractPath, "utf8")) as Contract;
  const variables = parsed.variables ?? [];

  const grouped = new Map<string, ContractVar[]>();
  for (const variable of variables) {
    const section = String(variable.section ?? "misc");
    if (!grouped.has(section)) {
      grouped.set(section, []);
    }
    grouped.get(section)?.push(variable);
  }

  const lines: string[] = [];
  lines.push("# ENV Owner Map");
  lines.push("");
  lines.push("Generated from `configs/env/contract.yaml`.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total variables: **${variables.length}**`);
  lines.push(`- Sections: **${grouped.size}**`);
  lines.push("- Policy: zero alias, canonical env names only.");
  lines.push("");

  const sections = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  for (const section of sections) {
    const meta =
      SECTION_OWNER[section] ??
      ({
        owner: "Platform Team",
        module: "TBD",
        doc: "docs/reference/configuration.md",
      } as const);
    const items = grouped.get(section) ?? [];
    lines.push(`## ${toSectionTitle(section)} (${items.length})`);
    lines.push("");
    lines.push(`- Owner: **${meta.owner}**`);
    lines.push(`- Module: \`${meta.module}\``);
    lines.push(`- Primary doc: \`${meta.doc}\``);
    lines.push("");
    lines.push("| Variable | Required | Sensitive |");
    lines.push("| --- | --- | --- |");
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `| \`${item.name}\` | ${item.required === true ? "yes" : "no"} | ${item.sensitive === true ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`[env-owner-map] generated ${outPath}\n`);
}

main();
