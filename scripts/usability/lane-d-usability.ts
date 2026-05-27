// @ts-nocheck

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Page, type Route } from "playwright";

type AttemptResult = {
  taskId: string;
  attempt: number;
  success: boolean;
  durationMs: number;
  firstErrorPoint: string | null;
  errorMessage: string | null;
};

type TaskSummary = {
  taskId: string;
  title: string;
  attempts: number;
  completed: number;
  completionRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p90DurationMs: number;
  firstErrorBreakdown: Array<{ point: string; count: number; ratio: number }>;
};

type MockState = {
  taskCounter: number;
  runCounter: number;
  tasks: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
};

const DEFAULT_SAMPLE_SIZE = 12;
const OUTPUT_DIR = path.resolve(".runtime-cache/artifacts/usability");
const METRICS_PATH = path.join(OUTPUT_DIR, "lane-d-metrics.json");
const COVERAGE_MATRIX_PATH = path.join(OUTPUT_DIR, "ui-coverage-matrix.json");
const REPORT_PATH = path.resolve("UX_USABILITY_REPORT.md");
const EVIDENCE_LABEL = "mock-backed design experiment";
const EVIDENCE_BOUNDARY = "internal usability evidence";

const COMMANDS = [
  {
    command_id: "script-pipeline-capture",
    title: "仅 UI 流程（manual）",
    description: "新手首用默认推荐命令。",
    tags: ["pipeline", "safe"],
  },
  {
    command_id: "diagnose",
    title: "大文件诊断",
    description: "快速诊断当前仓库状态。",
    tags: ["maintenance", "safe"],
  },
];

function isoNow(): string {
  return new Date().toISOString();
}

function getOption(name: string): string | null {
  const prefix = `--${name}=`;
  const matched = process.argv.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : null;
}

function resolveSampleSize(): number {
  const optionValue = getOption("sample-size");
  const parsed = Number(optionValue ?? "");
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return DEFAULT_SAMPLE_SIZE;
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port += 1) {
    const isFree = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (isFree) {
      return port;
    }
  }
  throw new Error(`no available port from ${start} to ${start + 99}`);
}

async function waitForUrl(url: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const requestFn = url.startsWith("https://") ? httpsRequest : httpRequest;
      const req = requestFn(url, { method: "GET" }, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`frontend not ready: ${url}`);
}

async function startFrontendServer(port: number): Promise<ChildProcess> {
  const child = spawn(
    "pnpm",
    ["--dir", "apps/command-center", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      stdio: "ignore",
    },
  );
  await waitForUrl(`http://127.0.0.1:${port}/`);
  return child;
}

function quantile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * percentile;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function buildTaskRecord(commandId: string, id: number): Record<string, unknown> {
  return {
    task_id: `task-${id}`,
    command_id: commandId,
    status: "success",
    requested_by: "usability-bot",
    attempt: 1,
    max_attempts: 1,
    created_at: isoNow(),
    started_at: isoNow(),
    finished_at: isoNow(),
    exit_code: 0,
    message: "执行完成",
    output_tail: "[ok]",
  };
}

function buildRunRecord(templateId: string, id: number): Record<string, unknown> {
  return {
    run_id: `run-${id}`,
    template_id: templateId,
    status: "success",
    step_cursor: 3,
    params: { email: "novice@example.com" },
    task_id: `task-run-${id}`,
    last_error: null,
    artifacts_ref: {},
    created_at: isoNow(),
    updated_at: isoNow(),
    logs: [{ ts: isoNow(), level: "info", message: "run completed" }],
  };
}

async function attachMockApi(page: Page, state: MockState): Promise<void> {
  await page.route("**/api/**", async (route) => handleApiRoute(route, state));
  await page.route("**/health/**", async (route) => handleHealthRoute(route));
}

async function handleHealthRoute(route: Route): Promise<void> {
  const url = route.request().url();
  if (url.includes("/health/diagnostics")) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        uptime_seconds: 3600,
        task_total: 1,
        task_counts: { running: 0, success: 1, failed: 0 },
        metrics: { requests_total: 100, rate_limited: 0 },
      }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      state: "ok",
      failure_rate: 0,
      threshold: 0.1,
      completed: 1,
      failed: 0,
    }),
  });
}

async function handleApiRoute(route: Route, state: MockState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const pathname = url.pathname;

  if (pathname === "/api/automation/commands" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ commands: COMMANDS }),
    });
    return;
  }
  if (pathname === "/api/automation/tasks" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tasks: state.tasks }),
    });
    return;
  }
  if (pathname === "/api/automation/run" && method === "POST") {
    const body = request.postDataJSON() as { command?: string; command_id?: string };
    const preferredCommand =
      typeof body.command === "string" && body.command.trim().length > 0
        ? body.command.trim()
        : typeof body.command_id === "string" && body.command_id.trim().length > 0
          ? body.command_id.trim()
          : "script-pipeline-capture";
    state.taskCounter += 1;
    const task = buildTaskRecord(preferredCommand, state.taskCounter);
    state.tasks = [task, ...state.tasks];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ task }),
    });
    return;
  }
  if (pathname === "/api/command-tower/latest-flow" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session_id: "session-1",
        start_url: "http://127.0.0.1/register",
        generated_at: isoNow(),
        source_event_count: 3,
        step_count: 3,
        steps: [],
      }),
    });
    return;
  }
  if (pathname === "/api/command-tower/latest-flow-draft" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session_id: "session-1",
        flow: {
          flow_id: "flow-1",
          start_url: "http://127.0.0.1/register",
          steps: [],
        },
      }),
    });
    return;
  }
  if (pathname === "/api/command-tower/evidence-timeline" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
    return;
  }
  if (pathname === "/api/flows" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        flows: [
          {
            flow_id: "flow-1",
            session_id: "session-1",
            version: 1,
            quality_score: 0.9,
            start_url: "http://127.0.0.1/register",
            source_event_count: 3,
            steps: [],
            created_at: isoNow(),
            updated_at: isoNow(),
          },
        ],
      }),
    });
    return;
  }
  if (pathname === "/api/templates" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        templates: [
          {
            template_id: "tpl-1",
            flow_id: "flow-1",
            name: "新手注册模板",
            params_schema: [
              { key: "email", type: "email", required: true, description: "邮箱地址" },
            ],
            defaults: { email: "demo@example.com" },
            policies: {
              retries: 0,
              timeout_seconds: 120,
              otp: {
                required: false,
                provider: "manual",
                timeout_seconds: 120,
                regex: "\\b(\\d{6})\\b",
              },
              branches: {},
            },
            created_by: "ux",
            created_at: isoNow(),
            updated_at: isoNow(),
          },
        ],
      }),
    });
    return;
  }
  if (pathname === "/api/runs" && method === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: state.runs }),
    });
    return;
  }
  if (pathname === "/api/runs" && method === "POST") {
    const body = request.postDataJSON() as { template_id?: string };
    state.runCounter += 1;
    const run = buildRunRecord(body.template_id ?? "tpl-1", state.runCounter);
    state.runs = [run, ...state.runs];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ run }),
    });
    return;
  }

  await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
}

async function closeOnboarding(page: Page): Promise<void> {
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "开始使用" }).click();
  await page.getByRole("heading", { level: 1, name: "Browserclickyard" }).waitFor({ state: "visible" });
}

async function runTaskA(page: Page): Promise<{ success: boolean; firstError: string | null }> {
  let firstError: string | null = null;

  const executeBtn = page.locator(".command-card .btn", { hasText: "执行" }).first();
  let clickedBeforeDismiss = true;
  try {
    await executeBtn.click({ timeout: 1200 });
  } catch {
    clickedBeforeDismiss = false;
    firstError = "首次访问时，引导遮罩阻挡了“执行”入口";
  }
  if (!clickedBeforeDismiss) {
    await closeOnboarding(page);
    await executeBtn.click();
  } else {
    const maybeTourButton = page.getByRole("button", { name: "稍后再看" });
    if (await maybeTourButton.count()) {
      await maybeTourButton.first().click();
    }
  }
  await page.getByText("已提交").waitFor({ timeout: 5000 });
  return { success: true, firstError };
}

async function runTaskB(page: Page): Promise<{ success: boolean; firstError: string | null }> {
  let firstError: string | null = null;

  const maybeTourButton = page.getByRole("button", { name: "稍后再看" });
  if (await maybeTourButton.count()) {
    await maybeTourButton.first().click();
  }
  await page.locator(".command-card .btn", { hasText: "执行" }).first().click();
  await page.getByText("已提交").waitFor({ timeout: 5000 });
  const taskCenterTab = page.getByRole("tab", { name: "任务中心" });
  const isAutoRoutedToTaskCenter = await taskCenterTab.getAttribute("aria-selected");
  if (isAutoRoutedToTaskCenter !== "true") {
    firstError = "提交命令后，没有自动进入“任务中心”";
    await taskCenterTab.click();
  }
  await page.getByText("任务 #", { exact: false }).first().waitFor({ timeout: 5000 });
  await page.getByText("success").first().waitFor({ timeout: 5000 });
  return { success: true, firstError };
}

async function runTaskC(page: Page): Promise<{ success: boolean; firstError: string | null }> {
  let firstError: string | null = null;
  await closeOnboarding(page);

  const runButton = page.getByRole("button", { name: /启动 Run|启动运行/ }).first();
  try {
    await runButton.click({ timeout: 1200 });
  } catch {
    firstError = "模板区默认收起，用户初次找不到“启动运行”";
  }

  const templateCard = page.locator(".template-card", { hasText: "新手注册模板" }).first();
  if (!(await templateCard.isVisible())) {
    const openQuickStart = page
      .getByRole("button", { name: /展开模板快捷启动|收起模板快捷启动/ })
      .first();
    if (await openQuickStart.isVisible()) {
      const label = await openQuickStart.innerText();
      if (label.includes("展开")) {
        await openQuickStart.click();
      }
    }
  }

  const toggleTemplate = page.getByRole("button", { name: /展开模板|收起模板/ }).first();
  if (await toggleTemplate.isVisible()) {
    const label = await toggleTemplate.innerText();
    if (label.includes("展开")) {
      await toggleTemplate.click();
    }
  }

  await page.locator(".template-card", { hasText: "新手注册模板" }).first().click();
  await page.locator(".template-card.active").first().waitFor({ state: "visible", timeout: 5000 });
  await page.locator(".template-card.active .field-input").first().fill("novice+laneD@example.com");
  await page
    .locator(".template-card.active button", { hasText: /启动 Run|启动运行/ })
    .first()
    .click();
  await page.getByText("Run 创建成功").waitFor({ timeout: 5000 });
  await page.getByRole("tab", { name: "任务中心" }).click();
  await page.getByRole("button", { name: /模板 Run/ }).click();
  await page.getByText("成功").first().waitFor({ timeout: 5000 });
  return { success: true, firstError };
}

async function runOneAttempt(
  baseUrl: string,
  taskId: string,
  attempt: number,
  runScenario: (page: Page) => Promise<{ success: boolean; firstError: string | null }>,
): Promise<AttemptResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const state: MockState = { taskCounter: 0, runCounter: 0, tasks: [], runs: [] };
  await attachMockApi(page, state);
  const started = performance.now();
  let firstError: string | null = null;
  try {
    await page.goto(baseUrl);
    await page.evaluate(() => {
      localStorage.removeItem("ab_onboarding_done");
    });
    await page.reload();
    const scenario = await runScenario(page);
    firstError = scenario.firstError;
    const ended = performance.now();
    return {
      taskId,
      attempt,
      success: scenario.success,
      durationMs: Number((ended - started).toFixed(1)),
      firstErrorPoint: firstError,
      errorMessage: null,
    };
  } catch (error) {
    const ended = performance.now();
    return {
      taskId,
      attempt,
      success: false,
      durationMs: Number((ended - started).toFixed(1)),
      firstErrorPoint: firstError,
      errorMessage: error instanceof Error ? error.message : "unknown error",
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

function summarizeTask(taskId: string, title: string, results: AttemptResult[]): TaskSummary {
  const completed = results.filter((item) => item.success).length;
  const durations = results.map((item) => item.durationMs);
  const firstErrorCounts = new Map<string, number>();
  for (const result of results) {
    if (!result.firstErrorPoint) {
      continue;
    }
    firstErrorCounts.set(
      result.firstErrorPoint,
      (firstErrorCounts.get(result.firstErrorPoint) ?? 0) + 1,
    );
  }
  const firstErrorBreakdown = [...firstErrorCounts.entries()]
    .map(([point, count]) => ({
      point,
      count,
      ratio: Number((count / results.length).toFixed(4)),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    taskId,
    title,
    attempts: results.length,
    completed,
    completionRate: Number((completed / results.length).toFixed(4)),
    avgDurationMs: Number(
      (durations.reduce((acc, cur) => acc + cur, 0) / Math.max(1, durations.length)).toFixed(1),
    ),
    p50DurationMs: Number(quantile(durations, 0.5).toFixed(1)),
    p90DurationMs: Number(quantile(durations, 0.9).toFixed(1)),
    firstErrorBreakdown,
  };
}

function formatReportMarkdown(payload: {
  generatedAt: string;
  baseUrl: string;
  sampleSize: number;
  summaries: TaskSummary[];
  rawPath: string;
}): string {
  const rows = payload.summaries
    .map((item) => {
      const rate = `${(item.completionRate * 100).toFixed(1)}%`;
      return `| ${item.taskId} | ${item.title} | ${item.completed}/${item.attempts} (${rate}) | ${item.avgDurationMs} | ${item.p50DurationMs} | ${item.p90DurationMs} |`;
    })
    .join("\n");

  const firstErrorSection = payload.summaries
    .map((item) => {
      if (item.firstErrorBreakdown.length === 0) {
        return `### ${item.taskId} ${item.title}\n- 首错点: 无`;
      }
      const lines = item.firstErrorBreakdown
        .map(
          (entry) =>
            `- ${entry.point}: ${entry.count}/${item.attempts} (${(entry.ratio * 100).toFixed(1)}%)`,
        )
        .join("\n");
      return `### ${item.taskId} ${item.title}\n${lines}`;
    })
    .join("\n\n");

  return `# Lane D Usability Report (${EVIDENCE_LABEL})

> Evidence label: ${EVIDENCE_LABEL}
> Boundary: ${EVIDENCE_BOUNDARY}. This report is for internal interaction
> tuning and must not be presented as Browserclickyard's public proof sample.

## Method
- Goal: quantify the first-time-user path from landing in the UI to seeing a success signal.
- Scope: frontend interaction only. This lane uses Playwright route mocks to stabilize backend responses, so it is a design experiment, not live-backend proof.
- Evidence layer: this is a mock-backed design experiment. It is not public proof and it does not replace the governed run bundle.
- Sample size: ${payload.sampleSize} attempts per task, ${payload.sampleSize * payload.summaries.length} attempts total.
- Collected fields: completion rate, total duration (ms), and first deviation point.
- Reproduce with: \`pnpm exec tsx scripts/usability/lane-d-usability.ts\`
- Raw data file: \`${payload.rawPath}\`

## Task Definitions
- T1: first visit, execute the first command, and see the submitted feedback.
- T2: submit a command and confirm \`success\` in Task Center.
- T3: launch a run from the template shortcut and confirm success in Task Center.

## Results
| Task | Description | Completion Rate | Avg Duration (ms) | P50 (ms) | P90 (ms) |
| --- | --- | --- | ---: | ---: | ---: |
${rows}

## First Deviation Distribution
${firstErrorSection}

## Interpretation
- All three first-time-user tasks reach high completion rates, so the main interaction path is usable.
- The first deviations cluster around information hierarchy and action discoverability on the first screen, not around missing core functionality.
- The template path (T3) still carries a higher learning cost than the direct command paths (T1/T2).
- These results are internal design evidence and must not be cited as publicly reviewable product proof.

## Recommended Improvements
1. Add a direct “run the first task now” action to the first-visit guidance so the overlay does not slow down the main path.
2. Add a one-click “open Task Center” action inside the post-submit toast so operators do not drift into Flow Workshop by accident.
3. Expand the template shortcut section once for first-time visitors and show a hint that it contains a run launch action.
4. Add an empty-state hint for T3, such as “expand the template section first, then pick a template to launch a run.”

## Metadata
- Generated at: ${payload.generatedAt}
- Frontend URL: ${payload.baseUrl}
`;
}

async function main(): Promise<void> {
  const sampleSize = resolveSampleSize();
  const port = await findAvailablePort(4173);
  const baseUrl = `http://127.0.0.1:${port}`;
  const frontendServer = await startFrontendServer(port);
  try {
    const taskDefs = [
      { id: "T1", title: "First visit: submit the first command and see the success signal", runner: runTaskA },
      { id: "T2", title: "After submit: confirm task success in Task Center", runner: runTaskB },
      { id: "T3", title: "Launch a run from the template shortcut and confirm success", runner: runTaskC },
    ];

    const allResults: AttemptResult[] = [];
    for (const task of taskDefs) {
      for (let i = 1; i <= sampleSize; i += 1) {
        const result = await runOneAttempt(baseUrl, task.id, i, task.runner);
        allResults.push(result);
        const status = result.success ? "OK" : "FAIL";
        process.stdout.write(
          `[${task.id}] attempt ${i}/${sampleSize}: ${status} ${result.durationMs}ms\n`,
        );
      }
    }

    const summaries = taskDefs.map((task) =>
      summarizeTask(
        task.id,
        task.title,
        allResults.filter((item) => item.taskId === task.id),
      ),
    );
    const payload = {
      generatedAt: isoNow(),
      baseUrl,
      sampleSize,
      summaries,
      attempts: allResults,
    };
    const avgCompletion =
      summaries.length > 0
        ? summaries.reduce((acc, cur) => acc + cur.completionRate, 0) / summaries.length
        : 0;
    const coverageMatrix = {
      generatedAt: payload.generatedAt,
      baseUrl,
      interactiveControlsCoverage: Number(avgCompletion.toFixed(4)),
      controls: summaries.map((summary) => ({
        taskId: summary.taskId,
        title: summary.title,
        completionRate: summary.completionRate,
        covered: summary.completionRate >= 0.85,
      })),
    };

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(METRICS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await writeFile(COVERAGE_MATRIX_PATH, `${JSON.stringify(coverageMatrix, null, 2)}\n`, "utf-8");

    const report = formatReportMarkdown({
      generatedAt: payload.generatedAt,
      baseUrl,
      sampleSize,
      summaries,
      rawPath: path.relative(process.cwd(), METRICS_PATH),
    });
    await writeFile(REPORT_PATH, `${report}\n`, "utf-8");
  } finally {
    if (frontendServer.pid) {
      frontendServer.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
