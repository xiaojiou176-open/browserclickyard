import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { AiReviewFinding } from "../../../../../ai-review/src/generate-findings.js";

export type FixExecutorMode = "auto" | "report_only";

export type FixPlanItem = {
  issue_id?: string;
  file_path?: string;
  patch_hint?: string;
};

export type FixTaskStatus = "planned" | "applied" | "failed";

export type FixTaskResult = {
  taskId: string;
  issueId: string;
  filePath: string;
  patchHint: string;
  status: FixTaskStatus;
  reasonCode: string;
  details?: string;
};

export type FixExecutorResult = {
  schemaVersion: "1.0";
  generatedAt: string;
  mode: FixExecutorMode;
  allowlist: string[];
  summary: {
    findings: number;
    totalTasks: number;
    planned: number;
    applied: number;
    failed: number;
  };
  tasks: FixTaskResult[];
  gate: {
    status: "passed" | "failed" | "blocked";
    reasonCode: string;
  };
  reportPath: string;
};

export type ExecuteFixExecutorInput = {
  baseDir: string;
  mode?: FixExecutorMode;
  allowlist?: string[];
  findings?: AiReviewFinding[];
  fixPlan?: FixPlanItem[];
  reportPath?: string;
};

const DEFAULT_FIX_MODE: FixExecutorMode = "report_only";
const DEFAULT_FIX_ALLOWLIST = ["packages", "apps", "backend", "frontend"];
const DEFAULT_FIX_REPORT_PATH = "reports/fix-result.json";

type ParsedPatchHint =
  | { kind: "replace"; from: string; to: string }
  | { kind: "append"; content: string }
  | { kind: "prepend"; content: string };

function pathWithin(root: string, target: string): boolean {
  if (target === root) {
    return true;
  }
  return target.startsWith(`${root}${sep}`);
}

function parsePatchHint(patchHint: string): ParsedPatchHint | null {
  const trimmed = patchHint.trim();
  const replaceMatch = /^replace::([\s\S]*?)::([\s\S]*)$/u.exec(trimmed);
  if (replaceMatch) {
    return {
      kind: "replace",
      from: replaceMatch[1] ?? "",
      to: replaceMatch[2] ?? "",
    };
  }
  const appendMatch = /^append::([\s\S]*)$/u.exec(trimmed);
  if (appendMatch) {
    return {
      kind: "append",
      content: appendMatch[1] ?? "",
    };
  }
  const prependMatch = /^prepend::([\s\S]*)$/u.exec(trimmed);
  if (prependMatch) {
    return {
      kind: "prepend",
      content: prependMatch[1] ?? "",
    };
  }
  return null;
}

function normalizeFixCandidates(input: ExecuteFixExecutorInput): FixPlanItem[] {
  if (input.fixPlan && input.fixPlan.length > 0) {
    return input.fixPlan;
  }
  return (input.findings ?? []).map((finding) => ({
    issue_id: finding.issue_id,
    file_path: finding.file_path,
    patch_hint: finding.patch_hint,
  }));
}

export function resolveAiFixModeFromEnv(): FixExecutorMode {
  const raw = (process.env.UIQ_AI_FIX_MODE ?? "").trim().toLowerCase();
  return raw === "auto" ? "auto" : "report_only";
}

export function resolveAiFixAllowlistFromEnv(): string[] {
  const raw = (process.env.UIQ_AI_FIX_ALLOWLIST ?? "").trim();
  if (raw.length === 0) {
    return [...DEFAULT_FIX_ALLOWLIST];
  }
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

export function executeFixExecutor(input: ExecuteFixExecutorInput): FixExecutorResult {
  const mode = input.mode ?? DEFAULT_FIX_MODE;
  const allowlist = (
    input.allowlist && input.allowlist.length > 0 ? input.allowlist : DEFAULT_FIX_ALLOWLIST
  ).map((item) => item.trim());
  const normalizedAllowlist = Array.from(new Set(allowlist.filter((item) => item.length > 0)));
  const allowRoots = normalizedAllowlist.map((entry) => resolve(input.baseDir, entry));
  const reportPath = input.reportPath ?? DEFAULT_FIX_REPORT_PATH;
  const reportAbsolutePath = resolve(input.baseDir, reportPath);
  const candidates = normalizeFixCandidates(input);
  const tasks: FixTaskResult[] = [];

  candidates.forEach((candidate, index) => {
    const taskId = `FIX-${String(index + 1).padStart(3, "0")}`;
    const issueId = (candidate.issue_id ?? "").trim() || taskId;
    const filePath = (candidate.file_path ?? "").trim();
    const patchHint = (candidate.patch_hint ?? "").trim();

    if (filePath.length === 0 || patchHint.length === 0) {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.invalid_candidate",
        details: "missing file_path or patch_hint",
      });
      return;
    }

    if (mode === "report_only") {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "planned",
        reasonCode: "gate.ai_fix.passed.report_only_planned",
        details: "report_only mode does not modify files",
      });
      return;
    }

    if (isAbsolute(filePath)) {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.absolute_path_forbidden",
        details: "file_path must be repository-relative",
      });
      return;
    }

    const absoluteFilePath = resolve(input.baseDir, filePath);
    if (!pathWithin(input.baseDir, absoluteFilePath)) {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.path_escape",
        details: "resolved file path escapes run base directory",
      });
      return;
    }
    if (!allowRoots.some((root) => pathWithin(root, absoluteFilePath))) {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.file_outside_allowlist",
        details: "file path is outside configured allowlist",
      });
      return;
    }

    let stats;
    try {
      stats = statSync(absoluteFilePath);
    } catch {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.file_not_found",
        details: "target file does not exist",
      });
      return;
    }
    if (!stats.isFile()) {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.target_not_file",
        details: "target path is not a file",
      });
      return;
    }

    const parsedPatchHint = parsePatchHint(patchHint);
    if (!parsedPatchHint) {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.patch_hint_unsupported",
        details: "supported formats: replace::from::to | append::content | prepend::content",
      });
      return;
    }

    const original = readFileSync(absoluteFilePath, "utf8");
    let next = original;
    if (parsedPatchHint.kind === "replace") {
      if (parsedPatchHint.from.length === 0) {
        tasks.push({
          taskId,
          issueId,
          filePath,
          patchHint,
          status: "failed",
          reasonCode: "gate.ai_fix.failed.replace_source_empty",
          details: "replace::from::to requires non-empty from segment",
        });
        return;
      }
      if (!original.includes(parsedPatchHint.from)) {
        tasks.push({
          taskId,
          issueId,
          filePath,
          patchHint,
          status: "failed",
          reasonCode: "gate.ai_fix.failed.replace_source_not_found",
          details: "replace source text not found in target file",
        });
        return;
      }
      next = original.replace(parsedPatchHint.from, parsedPatchHint.to);
    } else if (parsedPatchHint.kind === "append") {
      next = `${original}${parsedPatchHint.content}`;
    } else if (parsedPatchHint.kind === "prepend") {
      next = `${parsedPatchHint.content}${original}`;
    }

    if (next === original) {
      tasks.push({
        taskId,
        issueId,
        filePath,
        patchHint,
        status: "failed",
        reasonCode: "gate.ai_fix.failed.no_content_change",
        details: "computed patch did not change file content",
      });
      return;
    }

    writeFileSync(absoluteFilePath, next, "utf8");
    tasks.push({
      taskId,
      issueId,
      filePath,
      patchHint,
      status: "applied",
      reasonCode: "gate.ai_fix.passed.applied",
      details: "patch applied successfully",
    });
  });

  const planned = tasks.filter((task) => task.status === "planned").length;
  const applied = tasks.filter((task) => task.status === "applied").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const firstFailedReason = tasks.find((task) => task.status === "failed")?.reasonCode;
  const gate: FixExecutorResult["gate"] =
    tasks.length === 0
      ? {
          status: "passed",
          reasonCode: "gate.ai_fix.passed.no_tasks",
        }
      : failed > 0
        ? {
            status: "failed",
            reasonCode: firstFailedReason ?? "gate.ai_fix.failed.unspecified",
          }
        : mode === "report_only"
          ? {
              status: "passed",
              reasonCode: "gate.ai_fix.passed.report_only",
            }
          : applied > 0
            ? {
                status: "passed",
                reasonCode: "gate.ai_fix.passed.applied",
              }
            : {
                status: "passed",
                reasonCode: "gate.ai_fix.passed.noop",
              };

  const result: FixExecutorResult = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    mode,
    allowlist: normalizedAllowlist,
    summary: {
      findings: input.findings?.length ?? 0,
      totalTasks: tasks.length,
      planned,
      applied,
      failed,
    },
    tasks,
    gate,
    reportPath,
  };
  mkdirSync(dirname(reportAbsolutePath), { recursive: true });
  writeFileSync(reportAbsolutePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
