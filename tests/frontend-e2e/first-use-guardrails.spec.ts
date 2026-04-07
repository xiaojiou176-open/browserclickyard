// @ts-nocheck
import { expect, type Page, test } from "@playwright/test";
import {
  TASK_CENTER_DETAIL_COLUMN_TEST_ID,
} from "../../apps/command-center/src/constants/testIds";
import { gotoRootWithFrontendRetry } from "./support/frontend-navigation";

type StubOptions = {
  runs?: Array<{
    run_id: string;
    template_id: string;
    status:
      | "queued"
      | "running"
      | "waiting_user"
      | "waiting_otp"
      | "success"
      | "failed"
      | "cancelled";
    step_cursor: number;
    params?: Record<string, string>;
    task_id?: string | null;
    last_error?: string | null;
    artifacts_ref?: Record<string, string>;
    created_at?: string;
    updated_at?: string;
    logs?: Array<{ ts: string; level: "info" | "warn" | "error"; message: string }>;
  }>;
  onSubmitOtp?: (payload: { runId: string; otpCode: string }) => void;
};

async function stubBackendRequests(page: Page, options: StubOptions = {}) {
  const runsState = (options.runs ?? []).map((run) => ({
    params: {},
    task_id: null,
    last_error: null,
    artifacts_ref: {},
    created_at: "2026-02-19T00:00:00.000Z",
    updated_at: "2026-02-19T00:00:00.000Z",
    logs: [],
    ...run,
  }));

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.match(/^\/api\/runs\/[^/]+\/resume$/) && route.request().method() === "POST") {
      let otpCode = "";
      const raw = route.request().postData();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as {
            approved?: boolean;
            input_text?: string;
            otp_code?: string;
          };
          otpCode = parsed.otp_code ?? parsed.input_text ?? (parsed.approved ? "approved" : "");
        } catch {
          otpCode = "";
        }
      }
      const runId = url.pathname.split("/")[3] ?? "";
      const target = runsState.find((run) => run.run_id === runId);
      const previousStatus = target?.status;
      if (target) {
        target.status = "running";
        target.last_error = null;
        target.logs = [
          ...(target.logs ?? []),
          {
            ts: "2026-02-19T00:00:02.000Z",
            level: "info",
            message: previousStatus === "waiting_otp" ? "otp submitted" : "manual input submitted",
          },
        ];
      }
      options.onSubmitOtp?.({ runId, otpCode });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          run:
            target ??
            ({
              run_id: runId,
              status: "running",
            } as const),
        }),
      });
      return;
    }
    if (url.pathname.match(/^\/api\/runs\/[^/]+\/otp$/) && route.request().method() === "POST") {
      let otpCode = "";
      const raw = route.request().postData();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { otp_code?: string };
          otpCode = parsed.otp_code ?? "";
        } catch {
          otpCode = "";
        }
      }
      const runId = url.pathname.split("/")[3] ?? "";
      const target = runsState.find((run) => run.run_id === runId);
      if (target) {
        target.status = "running";
        target.last_error = null;
        target.logs = [
          ...(target.logs ?? []),
          { ts: "2026-02-19T00:00:02.000Z", level: "info", message: "otp submitted" },
        ];
      }
      options.onSubmitOtp?.({ runId, otpCode });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: runId, status: "running" }),
      });
      return;
    }
    if (url.pathname === "/api/automation/commands") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: [] }),
      });
      return;
    }
    if (url.pathname === "/api/automation/tasks") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
      return;
    }
    if (url.pathname === "/api/command-tower/latest-flow") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session_id: null, step_count: 0, source_event_count: 0, steps: [] }),
      });
      return;
    }
    if (url.pathname === "/api/command-tower/latest-flow-draft") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flow: null }),
      });
      return;
    }
    if (url.pathname === "/api/command-tower/evidence-timeline") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    if (url.pathname === "/api/command-tower/evidence") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "not found" }),
      });
      return;
    }
    if (url.pathname === "/api/flows") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flows: [] }),
      });
      return;
    }
    if (url.pathname === "/api/templates") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ templates: [] }),
      });
      return;
    }
    if (url.pathname.match(/^\/api\/templates\/[^/]+\/history$/)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ templates: [] }),
      });
      return;
    }
    if (url.pathname === "/api/runs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: runsState }),
      });
      return;
    }
    throw new Error(
      `[first-use-guardrails] Unhandled API route: ${route.request().method()} ${url.pathname}`,
    );
  });
  await page.route("**/health/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

async function bootstrapFirstUse(page: Page) {
  await stubBackendRequests(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("ab_onboarding_done", "1");
    window.localStorage.removeItem("ab_first_use_done");
    window.localStorage.removeItem("ab_first_use_stage");
    window.localStorage.removeItem("ab_first_use_progress");
  });
}

test.describe("@frontend-first-use guardrails", () => {
  test("@frontend-first-use guard config blocks run before valid params", async ({ page }) => {
    await bootstrapFirstUse(page);
    await gotoRootWithFrontendRetry(page);

    await expect(page.getByText("First-run guide")).toBeVisible();
    await page.getByRole("button", { name: "Jump to configuration" }).click();

    const baseUrlInput = page.locator("#base-url");
    await expect(baseUrlInput).toBeVisible();
    await baseUrlInput.fill("invalid-url", { force: true });

    const enterRunBtn = page.getByRole("button", { name: "Configuration complete, continue to run" });
    await expect(enterRunBtn).toBeDisabled();
    await expect(
      page.getByText("Please enter a valid baseUrl / startUrl (startUrl is optional) and configure successSelector."),
    ).toBeVisible();

    await baseUrlInput.fill("http://127.0.0.1:17380", { force: true });
    await expect(enterRunBtn).toBeEnabled();
  });

  test("@frontend-first-use guard verify blocks completion before result", async ({ page }) => {
    await stubBackendRequests(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("ab_onboarding_done", "1");
      window.localStorage.removeItem("ab_first_use_done");
      window.localStorage.setItem("ab_first_use_stage", "verify");
      window.localStorage.setItem(
        "ab_first_use_progress",
        JSON.stringify({ runTriggered: true, resultSeen: false }),
      );
    });

    await gotoRootWithFrontendRetry(page);

    await expect(
      page.getByText("A success or failure result has not been detected yet. Wait in Runs & Blocks before completing the guide."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete first-run guide" })).toBeDisabled();
  });
});

test.describe("@frontend-first-use resume", () => {
  test("@frontend-first-use resume waiting-otp run can resume after submit", async ({ page }) => {
    const submitted: Array<{ runId: string; otpCode: string }> = [];
    await stubBackendRequests(page, {
      runs: [
        {
          run_id: "run-waiting-otp-001",
          template_id: "tpl-demo-001",
          status: "waiting_otp",
          step_cursor: 2,
        },
      ],
      onSubmitOtp: (payload) => submitted.push(payload),
    });
    await page.addInitScript(() => {
      window.localStorage.setItem("ab_onboarding_done", "1");
      window.localStorage.setItem("ab_first_use_done", "1");
    });

    await gotoRootWithFrontendRetry(page);
    await page.getByRole("tab", { name: "Runs & Blocks" }).click();
    await page.getByRole("tab", { name: /^Lab runs\b/ }).click();
    await page
      .getByRole("listbox", { name: "Lab run list (templates)" })
      .getByRole("option")
      .first()
      .click();
    const manualGateDesk = page
      .getByTestId(TASK_CENTER_DETAIL_COLUMN_TEST_ID)
      .getByRole("region", { name: "Manual gate desk" });
    await expect(manualGateDesk.getByRole("heading", { name: "OTP required before resume" })).toBeVisible();

    await manualGateDesk.getByPlaceholder("Enter 4-8 digit OTP").fill("123456");
    await manualGateDesk.getByRole("button", { name: "Send OTP and resume" }).click();

    await expect(page.getByText("OTP submitted, run resumed")).toBeVisible();
    await expect.poll(() => submitted.length).toBe(1);
    await expect(submitted[0]).toEqual({ runId: "run-waiting-otp-001", otpCode: "123456" });
    await expect(
      page.getByTestId(TASK_CENTER_DETAIL_COLUMN_TEST_ID).getByText("Running", { exact: true }),
    ).toBeVisible();
  });

  test("@frontend-first-use resume waiting-user run can resume after submit", async ({ page }) => {
    const submitted: Array<{ runId: string; otpCode: string }> = [];
    await stubBackendRequests(page, {
      runs: [
        {
          run_id: "run-waiting-user-001",
          template_id: "tpl-demo-002",
          status: "waiting_user",
          step_cursor: 3,
        },
      ],
      onSubmitOtp: (payload) => submitted.push(payload),
    });
    await page.addInitScript(() => {
      window.localStorage.setItem("ab_onboarding_done", "1");
      window.localStorage.setItem("ab_first_use_done", "1");
    });

    await gotoRootWithFrontendRetry(page);
    await page.getByRole("tab", { name: "Runs & Blocks" }).click();
    await page.getByRole("tab", { name: /^Lab runs\b/ }).click();
    await page
      .getByRole("listbox", { name: "Lab run list (templates)" })
      .getByRole("option")
      .first()
      .click();
    const manualGateDesk = page
      .getByTestId(TASK_CENTER_DETAIL_COLUMN_TEST_ID)
      .getByRole("region", { name: "Manual gate desk" });
    await expect(manualGateDesk.getByRole("heading", { name: "Input required before resume" })).toBeVisible();

    await manualGateDesk.getByPlaceholder("Enter the requested input").fill("manual-input-001");
    await manualGateDesk.getByRole("button", { name: "Send input and resume" }).click();

    await expect(page.getByText("supplemental input submitted, run resumed")).toBeVisible();
    await expect.poll(() => submitted.length).toBe(1);
    await expect(submitted[0]).toEqual({
      runId: "run-waiting-user-001",
      otpCode: "manual-input-001",
    });
    await expect(
      page.getByTestId(TASK_CENTER_DETAIL_COLUMN_TEST_ID).getByText("Running", { exact: true }),
    ).toBeVisible();
  });
});
