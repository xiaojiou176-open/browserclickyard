import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

type ManifestEvidenceItem = {
  id: string;
  source: "state" | "report" | "gate" | "diagnostic";
  kind:
    | "screenshot"
    | "dom"
    | "trace"
    | "network"
    | "log"
    | "video"
    | "report"
    | "metric"
    | "other";
  path: string;
};

type ManifestGateCheck = {
  id: string;
  status: "passed" | "failed" | "blocked";
  reasonCode: string;
  evidencePath: string;
};

type RunManifest = {
  runId: string;
  profile: string;
  target: Record<string, unknown> & { type?: string; name?: string; baseUrl?: string };
  summary: {
    consoleError?: number;
    pageError?: number;
    http5xx?: number;
  };
  diagnostics?: {
    capture?: { consoleErrors?: string[]; pageErrors?: string[]; http5xxUrls?: string[] };
    explore?: { consoleErrors?: string[]; pageErrors?: string[]; http5xxUrls?: string[] };
    chaos?: { consoleErrors?: string[]; pageErrors?: string[]; http5xxUrls?: string[] };
  };
  gateResults?: { checks?: ManifestGateCheck[] };
  evidenceIndex?: ManifestEvidenceItem[];
  states?: Array<{ artifacts?: Record<string, string> }>;
};

type UiUxFinding = {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "ui" | "ux" | "functional" | "stability" | "performance" | "accessibility";
  reason_code: string;
  title: string;
  diagnosis: string;
  recommendation: string;
  evidence: string[];
};

type UiUxGeminiReport = {
  schemaVersion: "1.0";
  generatedAt: string;
  runId: string;
  profile: string;
  target: {
    type: string;
    name: string;
    baseUrl: string;
  };
  model: string;
  speed_mode: boolean;
  parallel_consistency: number;
  reason_code: string;
  reason_codes: string[];
  thought_signatures: {
    include_thoughts_enabled: boolean;
    status: "present" | "missing" | "parse_failed";
    reason_code: string;
    signatures: string[];
    signature_count: number;
  };
  summary: {
    verdict: "pass" | "needs_attention" | "critical_issues";
    overall_score: number;
    accuracy: number;
    sample_size: number;
    total_findings: number;
    high_or_above: number;
  };
  input_context: {
    screenshots: string[];
    video: string;
    errors: {
      console_error_count: number;
      page_error_count: number;
      http5xx_count: number;
      sample_console_errors: string[];
      sample_page_errors: string[];
      sample_http5xx_urls: string[];
      failed_gate_checks: Array<{ id: string; reason_code: string; evidence_path: string }>;
    };
  };
  findings: UiUxFinding[];
};

const RUNS_DIR_DEFAULT = ".runtime-cache/artifacts/runs";
const REPORT_PATH_DEFAULT = "reports/ui-ux-gemini-report.json";
const DEFAULT_GEMINI_PARALLEL_ATTEMPTS = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const GEMINI_KEY_ENV_KEYS = ["GEMINI_API_KEY", "LIVE_GEMINI_API_KEY"] as const;

const RESPONSE_SCHEMA = {
  type: "object",
  required: ["reason_code", "reason_codes", "summary", "findings"],
  properties: {
    reason_code: { type: "string" },
    reason_codes: { type: "array", items: { type: "string" } },
    summary: {
      type: "object",
      required: ["verdict", "overall_score"],
      properties: {
        verdict: { type: "string", enum: ["pass", "needs_attention", "critical_issues"] },
        overall_score: { type: "number" },
      },
      additionalProperties: true,
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "severity",
          "category",
          "reason_code",
          "title",
          "diagnosis",
          "recommendation",
          "evidence",
        ],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          category: {
            type: "string",
            enum: ["ui", "ux", "functional", "stability", "performance", "accessibility"],
          },
          reason_code: { type: "string" },
          title: { type: "string" },
          diagnosis: { type: "string" },
          recommendation: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const;

function getArg(name: string): string | null {
  const token = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(token));
  return hit ? hit.slice(token.length) : null;
}

function parseBoolean(raw: string | null, fallback: boolean): boolean {
  if (raw === null) {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`[ai.gemini.invalid_argument] --speed_mode must be true|false`);
}

function parseTopN(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`[ai.gemini.invalid_argument] --top_screenshots must be integer in [1,10]`);
  }
  return value;
}

function parseParallelConsistency(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new Error("[ai.gemini.invalid_argument] --parallel_consistency must be integer in [1,6]");
  }
  return value;
}

function resolveIncludeThoughts(speedMode: boolean): boolean {
  return !speedMode;
}

export type ParsedGeminiResponse = {
  reason_code: string;
  reason_codes: string[];
  summary: { verdict: "pass" | "needs_attention" | "critical_issues"; overall_score: number };
  findings: UiUxFinding[];
};

function computeParallelConsistencyScore(
  responses: Array<{ parsed: ParsedGeminiResponse }>,
): number {
  if (responses.length <= 1) {
    return 1;
  }
  const counts = new Map<string, number>();
  for (const item of responses) {
    const signature = JSON.stringify({
      reason_code: item.parsed.reason_code,
      verdict: item.parsed.summary?.verdict ?? "needs_attention",
      findings: (item.parsed.findings ?? []).map(
        (finding) => `${finding.severity}:${finding.reason_code}`,
      ),
    });
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const highestAgreement = Math.max(...counts.values());
  return Number((highestAgreement / responses.length).toFixed(6));
}

const VERDICT_STRICTNESS_RANK: Record<ParsedGeminiResponse["summary"]["verdict"], number> = {
  critical_issues: 0,
  needs_attention: 1,
  pass: 2,
};

function resolveOverallScore(parsed: ParsedGeminiResponse): number {
  return Number(parsed.summary?.overall_score ?? 0);
}

function resolveHighOrAboveCount(parsed: ParsedGeminiResponse): number {
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  return findings.filter((item) => item.severity === "critical" || item.severity === "high").length;
}

function resolveStrictestHighOrAboveCount(
  responses: Array<{ parsed: ParsedGeminiResponse }>,
): number {
  return responses.reduce((highest, item) => {
    return Math.max(highest, resolveHighOrAboveCount(item.parsed));
  }, 0);
}

function isHighOrAboveFinding(finding: UiUxFinding): boolean {
  return finding.severity === "critical" || finding.severity === "high";
}

function findingSignalKey(finding: UiUxFinding): string {
  return `${finding.severity}::${finding.reason_code}`;
}

function ensureArrayFindingList(
  findings: ParsedGeminiResponse["findings"] | undefined,
): UiUxFinding[] {
  return Array.isArray(findings) ? findings : [];
}

export type GeminiParallelResponseItem = {
  backend: string;
  index: number;
  parsed: ParsedGeminiResponse;
};

export function mergeRepresentativeWithMinorityHighFindings(
  representative: ParsedGeminiResponse,
  responses: GeminiParallelResponseItem[],
): UiUxFinding[] {
  const representativeFindings = ensureArrayFindingList(representative.findings);
  if (responses.length <= 1) {
    return representativeFindings;
  }

  const representativeHighSignals = new Set(
    representativeFindings.filter(isHighOrAboveFinding).map(findingSignalKey),
  );
  const buckets = new Map<
    string,
    {
      count: number;
      sample: UiUxFinding;
      sources: Set<string>;
    }
  >();

  for (const response of responses) {
    const findings = ensureArrayFindingList(response.parsed.findings);
    for (const finding of findings) {
      if (!isHighOrAboveFinding(finding)) {
        continue;
      }
      const key = findingSignalKey(finding);
      const source = `${response.backend}#${String(response.index + 1)}`;
      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, {
          count: 1,
          sample: finding,
          sources: new Set([source]),
        });
        continue;
      }
      existing.count += 1;
      existing.sources.add(source);
    }
  }

  const minorityFindings: UiUxFinding[] = [];
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.count < 2) {
      continue;
    }
    if (representativeHighSignals.has(key)) {
      continue;
    }
    const fallbackId = bucket.sample.reason_code.replace(/[^a-zA-Z0-9._-]/g, "_");
    const baseId = bucket.sample.id && bucket.sample.id.trim() ? bucket.sample.id : fallbackId;
    const evidence = new Set(bucket.sample.evidence ?? []);
    evidence.add(`gemini.parallel.minority_high_or_above=${bucket.count}/${responses.length}`);
    evidence.add(`gemini.parallel.sources=${[...bucket.sources].sort().join(",")}`);
    minorityFindings.push({
      ...bucket.sample,
      id: `${baseId}-minority-${bucket.count}`,
      diagnosis: `${bucket.sample.diagnosis} [Minority high-severity signal observed in ${bucket.count}/${responses.length} parallel Gemini responses.]`,
      evidence: [...evidence],
    });
  }

  return [...representativeFindings, ...minorityFindings];
}

function resolveLowerMedian(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function resolveUpperMedian(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) / 2)] ?? 0;
}

function resolveMajorityVerdict(
  responses: Array<{ parsed: ParsedGeminiResponse }>,
): ParsedGeminiResponse["summary"]["verdict"] {
  const counts = new Map<ParsedGeminiResponse["summary"]["verdict"], number>();
  for (const item of responses) {
    const verdict = item.parsed.summary?.verdict ?? "needs_attention";
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  let selected: ParsedGeminiResponse["summary"]["verdict"] = "needs_attention";
  let selectedCount = -1;
  for (const [verdict, count] of counts.entries()) {
    const selectedRank = VERDICT_STRICTNESS_RANK[selected];
    const verdictRank = VERDICT_STRICTNESS_RANK[verdict];
    if (count > selectedCount || (count === selectedCount && verdictRank < selectedRank)) {
      selected = verdict;
      selectedCount = count;
    }
  }
  return selected;
}

export function chooseRepresentativeResponse<
  T extends {
    parsed: ParsedGeminiResponse;
    index: number;
  },
>(responses: T[]): T {
  if (responses.length === 1) {
    return responses[0];
  }
  const targetVerdict = resolveMajorityVerdict(responses);
  const targetScore = resolveLowerMedian(responses.map((item) => resolveOverallScore(item.parsed)));
  const targetHighOrAbove = resolveUpperMedian(
    responses.map((item) => resolveHighOrAboveCount(item.parsed)),
  );
  const preferred = responses.filter(
    (item) => (item.parsed.summary?.verdict ?? "needs_attention") === targetVerdict,
  );
  const pool = preferred.length > 0 ? preferred : responses;
  const scored = [...pool].sort((left, right) => {
    const leftHighDistance = Math.abs(resolveHighOrAboveCount(left.parsed) - targetHighOrAbove);
    const rightHighDistance = Math.abs(resolveHighOrAboveCount(right.parsed) - targetHighOrAbove);
    if (leftHighDistance !== rightHighDistance) {
      return leftHighDistance - rightHighDistance;
    }
    const leftScoreDistance = Math.abs(resolveOverallScore(left.parsed) - targetScore);
    const rightScoreDistance = Math.abs(resolveOverallScore(right.parsed) - targetScore);
    if (leftScoreDistance !== rightScoreDistance) {
      return leftScoreDistance - rightScoreDistance;
    }
    const leftScore = resolveOverallScore(left.parsed);
    const rightScore = resolveOverallScore(right.parsed);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    const leftHighOrAbove = resolveHighOrAboveCount(left.parsed);
    const rightHighOrAbove = resolveHighOrAboveCount(right.parsed);
    if (leftHighOrAbove !== rightHighOrAbove) {
      return rightHighOrAbove - leftHighOrAbove;
    }
    return left.index - right.index;
  });
  return scored[0] ?? responses[0];
}

type ThoughtSignatureResult = {
  status: "present" | "missing" | "parse_failed";
  reason_code: string;
  signatures: string[];
};

function extractThoughtSignatures(response: unknown): ThoughtSignatureResult {
  try {
    const root = response as {
      candidates?: Array<{
        content?: {
          parts?: Array<Record<string, unknown>>;
        };
      }>;
    };
    const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
    const signatures = new Set<string>();
    let malformed = false;

    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        const directValues = [
          part.thoughtSignature,
          part.thought_signature,
          part.signature,
          part.thought_signature_text,
        ];
        for (const value of directValues) {
          if (value === undefined || value === null) {
            continue;
          }
          if (typeof value === "string" && value.trim()) {
            signatures.add(value.trim());
          } else {
            malformed = true;
          }
        }

        const thought = part.thought;
        if (thought && typeof thought === "object") {
          const thoughtRecord = thought as Record<string, unknown>;
          const nestedValues = [
            thoughtRecord.thoughtSignature,
            thoughtRecord.thought_signature,
            thoughtRecord.signature,
          ];
          for (const value of nestedValues) {
            if (value === undefined || value === null) {
              continue;
            }
            if (typeof value === "string" && value.trim()) {
              signatures.add(value.trim());
            } else {
              malformed = true;
            }
          }
        }
      }
    }

    if (signatures.size > 0) {
      return {
        status: "present",
        reason_code: "ai.gemini.thought_signature.present",
        signatures: [...signatures],
      };
    }
    if (malformed) {
      return {
        status: "parse_failed",
        reason_code: "ai.gemini.thought_signature.parse_failed",
        signatures: [],
      };
    }
    return {
      status: "missing",
      reason_code: "ai.gemini.thought_signature.missing",
      signatures: [],
    };
  } catch {
    return {
      status: "parse_failed",
      reason_code: "ai.gemini.thought_signature.parse_failed",
      signatures: [],
    };
  }
}

type EnvLike = NodeJS.ProcessEnv;
type GeminiClientCandidate = {
  label: string;
  client: GoogleGenAI;
  model: string;
};

export function resolveGeminiModelFromEnv(speedMode: boolean, env: EnvLike = process.env): string {
  if (speedMode) {
    const fastModel = (env.GEMINI_FAST_MODEL ?? "").trim();
    if (!fastModel) {
      throw new Error(
        "[ai.gemini.unavailable.missing_model_env] GEMINI_FAST_MODEL is required when --speed_mode=true",
      );
    }
    return fastModel;
  }

  const primaryModel = (env.GEMINI_MODEL ?? "").trim();
  if (!primaryModel) {
    throw new Error(
      "[ai.gemini.unavailable.missing_model_env] GEMINI_MODEL is required when --speed_mode=false",
    );
  }
  return primaryModel;
}

function stripWrappingQuotes(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function readEnvValueFromRepoRoot(keys: readonly string[]): string {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) {
    return "";
  }
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!match || !keys.includes(match[1])) {
      continue;
    }
    const rawValue = match[2].split(/\s+#/, 1)[0] ?? "";
    const value = stripWrappingQuotes(rawValue);
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveGeminiApiKey(env: EnvLike = process.env): string {
  for (const key of GEMINI_KEY_ENV_KEYS) {
    const value = (env[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return readEnvValueFromRepoRoot(GEMINI_KEY_ENV_KEYS);
}

function readGcloudProjectFromConfig(): string {
  try {
    return execFileSync("gcloud", ["config", "get-value", "project"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveVertexProject(env: EnvLike = process.env): string {
  return (
    (env.GOOGLE_CLOUD_PROJECT ?? "").trim() ||
    (env.GCLOUD_PROJECT ?? "").trim() ||
    readGcloudProjectFromConfig()
  );
}

function resolveVertexLocation(env: EnvLike = process.env): string {
  return (env.GOOGLE_CLOUD_LOCATION ?? env.GEMINI_VERTEX_LOCATION ?? "us-central1").trim();
}

function normalizeModelForVertex(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function buildGeminiClientCandidates(
  model: string,
  apiKey: string,
  env: EnvLike = process.env,
): GeminiClientCandidate[] {
  const candidates: GeminiClientCandidate[] = [];
  if (apiKey) {
    candidates.push({
      label: "developer-api",
      client: new GoogleGenAI({ apiKey }),
      model,
    });
  }

  const vertexProject = resolveVertexProject(env);
  if (vertexProject) {
    candidates.push({
      label: "vertex-ai",
      client: new GoogleGenAI({
        vertexai: true,
        project: vertexProject,
        location: resolveVertexLocation(env),
        apiVersion: env.GOOGLE_GENAI_API_VERSION?.trim() || "v1",
      }),
      model: normalizeModelForVertex(model),
    });
  }

  return candidates;
}

function extToMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".mp4") {
    return "video/mp4";
  }
  if (ext === ".webm") {
    return "video/webm";
  }
  throw new Error(
    `[ai.gemini.input.unsupported_media] unsupported media extension: ${ext || "<none>"}`,
  );
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function findLatestRunDir(runsDir: string): Promise<string> {
  const entries = await readdir(runsDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  const withManifest: Array<{ dir: string; mtimeMs: number }> = [];
  for (const dir of dirs) {
    const manifestPath = path.join(runsDir, dir.name, "manifest.json");
    try {
      const fileStat = await stat(manifestPath);
      withManifest.push({ dir: dir.name, mtimeMs: fileStat.mtimeMs });
    } catch {
      // ignore entries without manifest
    }
  }
  if (withManifest.length === 0) {
    throw new Error(`[ai.gemini.input.no_run_manifest] no run manifest found under ${runsDir}`);
  }
  withManifest.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withManifest[0]?.dir;
}

async function pickArtifacts(
  manifest: RunManifest,
  runDir: string,
  topScreenshots: number,
): Promise<{ screenshots: string[]; video: string | null }> {
  const evidence = manifest.evidenceIndex ?? [];
  const screenshotsFromEvidence = evidence
    .filter((item) => item.kind === "screenshot")
    .map((item) => item.path);
  const screenshotsFromStates = (manifest.states ?? [])
    .map((state) => state.artifacts?.screenshot)
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
  const screenshotDedupe = [...new Set([...screenshotsFromEvidence, ...screenshotsFromStates])];
  let screenshots = screenshotDedupe.slice(0, topScreenshots);
  let video = evidence.find((item) => item.kind === "video")?.path ?? "";

  if (screenshots.length === 0) {
    const screenshotsDir = path.join(runDir, "screenshots");
    try {
      const media = await readdir(screenshotsDir, { withFileTypes: true });
      screenshots = media
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) =>
          [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(name).toLowerCase()),
        )
        .sort()
        .slice(0, topScreenshots)
        .map((name) => path.posix.join("screenshots", name));
    } catch {
      // ignore screenshots dir fallback failure
    }
  }

  if (!video) {
    const stateVideo = (manifest.states ?? [])
      .map((state) => state.artifacts?.video)
      .find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
    if (stateVideo) {
      video = stateVideo;
    }
  }

  if (!video) {
    const videosDir = path.join(runDir, "videos");
    try {
      const media = await readdir(videosDir, { withFileTypes: true });
      const candidate = media
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .find((name) => [".mp4", ".webm"].includes(path.extname(name).toLowerCase()));
      if (candidate) {
        video = path.posix.join("videos", candidate);
      }
    } catch {
      // ignore videos dir fallback failure
    }
  }

  if (screenshots.length === 0) {
    throw new Error(
      `[ai.gemini.input.missing_screenshot] no screenshot evidence found in manifest or screenshots directory`,
    );
  }
  return { screenshots, video: video || null };
}

function gatherErrorContext(manifest: RunManifest): UiUxGeminiReport["input_context"]["errors"] {
  const capture = manifest.diagnostics?.capture ?? {};
  const explore = manifest.diagnostics?.explore ?? {};
  const chaos = manifest.diagnostics?.chaos ?? {};

  const consoleErrors = [
    ...(capture.consoleErrors ?? []),
    ...(explore.consoleErrors ?? []),
    ...(chaos.consoleErrors ?? []),
  ];
  const pageErrors = [
    ...(capture.pageErrors ?? []),
    ...(explore.pageErrors ?? []),
    ...(chaos.pageErrors ?? []),
  ];
  const http5xxUrls = [
    ...(capture.http5xxUrls ?? []),
    ...(explore.http5xxUrls ?? []),
    ...(chaos.http5xxUrls ?? []),
  ];

  const failedChecks = (manifest.gateResults?.checks ?? [])
    .filter((check) => check.status !== "passed")
    .map((check) => ({
      id: check.id,
      reason_code: check.reasonCode,
      evidence_path: check.evidencePath,
    }));

  return {
    console_error_count: Number(manifest.summary.consoleError ?? consoleErrors.length),
    page_error_count: Number(manifest.summary.pageError ?? pageErrors.length),
    http5xx_count: Number(manifest.summary.http5xx ?? http5xxUrls.length),
    sample_console_errors: consoleErrors.slice(0, 10),
    sample_page_errors: pageErrors.slice(0, 10),
    sample_http5xx_urls: http5xxUrls.slice(0, 10),
    failed_gate_checks: failedChecks.slice(0, 20),
  };
}

function buildPrompt(context: {
  runId: string;
  profile: string;
  target: { type: string; name: string; baseUrl: string };
  screenshots: string[];
  video: string | null;
  errors: UiUxGeminiReport["input_context"]["errors"];
}): string {
  return [
    "You are a senior QA analyst.",
    "Analyze the provided browser screenshots + video + error context.",
    "Return STRICT JSON only, no markdown.",
    "Every finding MUST include a machine-readable reason_code.",
    "Use reason_code prefixes: ai.gemini.ui_ux., gate.ai_review., gate.ai_fix.",
    "Focus on: UI correctness, UX friction, functional regressions, stability, performance, accessibility.",
    "Must explicitly review: component consistency, visual hierarchy, interaction feedback, reduced-motion behavior, a11y risk, layout density, empty/error states, cross-view style drift.",
    "Output schema fields required by response schema.",
    "",
    `Run ID: ${context.runId}`,
    `Profile: ${context.profile}`,
    `Target: ${context.target.type}/${context.target.name} (${context.target.baseUrl})`,
    `Screenshot artifacts: ${context.screenshots.join(", ")}`,
    `Video artifact: ${context.video ?? "<none>"}`,
    `Error context: ${JSON.stringify(context.errors)}`,
  ].join("\n");
}

function validateReasonCodes(
  report: Pick<UiUxGeminiReport, "reason_code" | "reason_codes" | "findings">,
): void {
  if (!report.reason_code || typeof report.reason_code !== "string") {
    throw new Error(
      "[ai.gemini.failed.invalid_response_reason_code] top-level reason_code is missing",
    );
  }
  if (!Array.isArray(report.reason_codes) || report.reason_codes.length === 0) {
    throw new Error(
      "[ai.gemini.failed.invalid_response_reason_codes] top-level reason_codes is missing",
    );
  }
  for (const finding of report.findings) {
    if (!finding.reason_code || typeof finding.reason_code !== "string") {
      throw new Error(
        "[ai.gemini.failed.invalid_finding_reason_code] finding reason_code is missing",
      );
    }
  }
}

async function toInlineDataPart(
  filePath: string,
  maxBytes: number,
): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const raw = await readFile(filePath);
  if (raw.byteLength > maxBytes) {
    throw new Error(
      `[ai.gemini.input.media_too_large] ${path.basename(filePath)} exceeds ${maxBytes} bytes`,
    );
  }
  return {
    inlineData: {
      mimeType: extToMime(filePath),
      data: raw.toString("base64"),
    },
  };
}

async function main(): Promise<void> {
  const runsDirRaw = getArg("runs_dir") ?? RUNS_DIR_DEFAULT;
  const runsDir = path.isAbsolute(runsDirRaw) ? runsDirRaw : path.resolve(REPO_ROOT, runsDirRaw);
  const explicitRunId = getArg("run_id");
  const speedMode = parseBoolean(getArg("speed_mode"), false);
  const topScreenshots = parseTopN(getArg("top_screenshots"), 5);
  const parallelConsistency = parseParallelConsistency(
    getArg("parallel_consistency") ?? process.env.UIQ_GEMINI_PARALLEL_CONSISTENCY ?? null,
    DEFAULT_GEMINI_PARALLEL_ATTEMPTS,
  );
  const includeThoughts = resolveIncludeThoughts(speedMode);
  const outputRaw = getArg("output") ?? REPORT_PATH_DEFAULT;
  const model = resolveGeminiModelFromEnv(speedMode);
  const apiKey = resolveGeminiApiKey();
  const geminiCandidates = buildGeminiClientCandidates(model, apiKey);
  if (geminiCandidates.length === 0) {
    throw new Error(
      "[ai.gemini.unavailable.no_credentials] GEMINI_API_KEY/LIVE_GEMINI_API_KEY or Vertex ADC/project is required",
    );
  }

  const runId = explicitRunId ? explicitRunId.trim() : await findLatestRunDir(runsDir);
  if (!runId) {
    throw new Error("[ai.gemini.input.invalid_run_id] resolved run id is empty");
  }

  const runDir = path.resolve(runsDir, runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = await readJson<RunManifest>(manifestPath);
  const artifacts = await pickArtifacts(manifest, runDir, topScreenshots);
  const errors = gatherErrorContext(manifest);

  const screenshotAbsolutePaths = artifacts.screenshots.map((relPath) =>
    path.resolve(runDir, relPath),
  );
  const prompt = buildPrompt({
    runId: manifest.runId,
    profile: manifest.profile,
    target: {
      type: String(manifest.target.type ?? "unknown"),
      name: String(manifest.target.name ?? "unknown"),
      baseUrl: String(manifest.target.baseUrl ?? ""),
    },
    screenshots: artifacts.screenshots,
    video: artifacts.video,
    errors,
  });

  const contentsParts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [{ text: prompt }];
  for (const imagePath of screenshotAbsolutePaths) {
    contentsParts.push(await toInlineDataPart(imagePath, MAX_IMAGE_BYTES));
  }
  if (artifacts.video) {
    const videoAbsolutePath = path.resolve(runDir, artifacts.video);
    contentsParts.push(await toInlineDataPart(videoAbsolutePath, MAX_VIDEO_BYTES));
  }

  const successful: Array<{
    backend: string;
    index: number;
    response: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
    parsed: ParsedGeminiResponse;
  }> = [];
  const failures: string[] = [];
  for (const candidate of geminiCandidates) {
    const requestPayload = {
      model: candidate.model,
      contents: [{ role: "user", parts: contentsParts }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
        temperature: 0,
        ...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}),
      },
    };

    const attempts = Array.from({ length: parallelConsistency }, () =>
      candidate.client.models.generateContent(requestPayload),
    );
    const settled = await Promise.allSettled(attempts);
    for (const [index, result] of settled.entries()) {
      if (result.status === "rejected") {
        failures.push(`${candidate.label}.attempt_${String(index + 1)}: ${String(result.reason)}`);
        continue;
      }
      const responseText = result.value.text?.trim() ?? "";
      if (!responseText) {
        failures.push(`${candidate.label}.attempt_${String(index + 1)}: empty_response`);
        continue;
      }
      try {
        const parsed = JSON.parse(responseText) as ParsedGeminiResponse;
        successful.push({ backend: candidate.label, index, response: result.value, parsed });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${candidate.label}.attempt_${String(index + 1)}: invalid_json(${message})`);
      }
    }
    if (successful.length > 0) {
      break;
    }
  }
  if (successful.length === 0) {
    throw new Error(
      `[ai.gemini.failed.all_attempts_failed] ${failures.join(" | ") || "no successful attempts"}`,
    );
  }
  const selected = chooseRepresentativeResponse(successful);
  const thoughtSignatures = extractThoughtSignatures(selected.response);
  const parsed = selected.parsed;
  const normalizedAccuracy = Math.max(
    0,
    Math.min(1, Number(parsed.summary?.overall_score ?? 0) / 100),
  );

  const findings = mergeRepresentativeWithMinorityHighFindings(parsed, successful);
  const measuredParallelConsistency = computeParallelConsistencyScore(successful);
  const strictestHighOrAbove = resolveStrictestHighOrAboveCount(successful);
  const report: UiUxGeminiReport = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    runId: manifest.runId,
    profile: manifest.profile,
    target: {
      type: String(manifest.target.type ?? "unknown"),
      name: String(manifest.target.name ?? "unknown"),
      baseUrl: String(manifest.target.baseUrl ?? ""),
    },
    model,
    speed_mode: speedMode,
    parallel_consistency: measuredParallelConsistency,
    reason_code: parsed.reason_code,
    reason_codes: parsed.reason_codes,
    thought_signatures: {
      include_thoughts_enabled: includeThoughts,
      status: thoughtSignatures.status,
      reason_code: thoughtSignatures.reason_code,
      signatures: thoughtSignatures.signatures,
      signature_count: thoughtSignatures.signatures.length,
    },
    summary: {
      verdict: parsed.summary?.verdict ?? "needs_attention",
      overall_score: Number(parsed.summary?.overall_score ?? 0),
      accuracy: normalizedAccuracy,
      sample_size: successful.length,
      total_findings: findings.length,
      high_or_above: strictestHighOrAbove,
    },
    input_context: {
      screenshots: artifacts.screenshots,
      video: artifacts.video ?? "",
      errors,
    },
    findings,
  };

  validateReasonCodes(report);

  const outputPath = path.isAbsolute(outputRaw) ? outputRaw : path.resolve(runDir, outputRaw);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8");

  process.stdout.write(
    `${JSON.stringify(
      {
        runId: report.runId,
        model: report.model,
        speed_mode: report.speed_mode,
        reason_code: report.reason_code,
        reason_codes: report.reason_codes,
        findings: report.summary.total_findings,
        output: outputPath,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`generate-ui-ux-gemini-report failed: ${message}\n`);
    process.exitCode = 1;
  });
}
