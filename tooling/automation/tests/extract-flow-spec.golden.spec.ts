import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

type FlowSpec = {
  generatedAt: string;
  sourceHarPath: string;
  actionEndpoint: {
    method: string;
    fullUrl: string;
    path: string;
    contentType: string | null;
  } | null;
  registerEndpoint: {
    method: string;
    fullUrl: string;
    path: string;
    contentType: string | null;
  } | null;
  bootstrapSequence: Array<{
    method: string;
    fullUrl: string;
    path: string;
    reason: string;
  }>;
  replayHints: {
    bodyMode: "json" | "form" | "raw" | "none";
    contentType: string | null;
    tokenHeaderNames: string[];
    successStatuses: number[];
  };
  security: {
    tokenHeaderNames: string[];
    cookieNames: string[];
    hasAuthorization: boolean;
  };
  csrfBootstrap: {
    exists: boolean;
    fullUrl: string | null;
    path: string | null;
  };
  requiredHeaders: Record<string, string>;
  payloadExample: Record<string, unknown>;
  requests: Array<{
    startedAt: string;
    method: string;
    url: string;
    path: string;
    status: number;
  }>;
};

type CompatibilitySpec = {
  registerEndpoint: {
    path: string;
  } | null;
  csrfBootstrap: {
    exists: boolean;
    path: string | null;
  };
  security: {
    hasAuthorization: boolean;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMATION_ROOT = path.resolve(__dirname, "..");
const FIXTURE_ROOT = path.join(AUTOMATION_ROOT, "tests", "fixtures", "flow-spec-har");
const RUNTIME_ROOT = path.resolve(
  AUTOMATION_ROOT,
  "..",
  ".runtime-cache",
  "test-output",
  "automation-flow-spec-golden",
);

function runExtractFromFixture(fixtureFile: string): {
  spec: FlowSpec;
  compatibility: CompatibilitySpec;
  harPath: string;
} {
  const caseName = fixtureFile.replace(/\.har\.json$/, "");
  const caseDir = path.join(RUNTIME_ROOT, caseName);
  mkdirSync(caseDir, { recursive: true });

  const fixturePath = path.join(FIXTURE_ROOT, fixtureFile);
  const harPath = path.join(caseDir, "register.har");
  cpSync(fixturePath, harPath);

  execFileSync("pnpm", ["tsx", "scripts/extract-flow-spec.ts", `--har=${harPath}`], {
    cwd: AUTOMATION_ROOT,
    stdio: "pipe",
  });

  const spec = JSON.parse(
    readFileSync(path.join(caseDir, "flow_request.spec.json"), "utf-8"),
  ) as FlowSpec;
  const compatibility = JSON.parse(
    readFileSync(path.join(caseDir, "register_request.spec.json"), "utf-8"),
  ) as CompatibilitySpec;
  return { spec, compatibility, harPath };
}

function assertBaseShape(spec: FlowSpec, harPath: string): void {
  expect(new Date(spec.generatedAt).toString()).not.toBe("Invalid Date");
  expect(spec.sourceHarPath).toBe(harPath);
  expect(spec.actionEndpoint).not.toBeNull();
  expect(spec.registerEndpoint).not.toBeNull();
  expect(spec.requests.length).toBeGreaterThanOrEqual(1);
}

test.describe("extract-flow-spec golden HAR regression", () => {
  test("json register payload keeps endpoint, mode, and redaction stable", async () => {
    const { spec, compatibility, harPath } = runExtractFromFixture("json-register.har.json");
    assertBaseShape(spec, harPath);

    expect(spec.actionEndpoint?.method).toBe("POST");
    expect(spec.actionEndpoint?.path).toBe("/api/register");
    expect(spec.replayHints.bodyMode).toBe("json");
    expect(spec.replayHints.contentType).toBe("application/json");
    expect(spec.replayHints.successStatuses).toEqual([201]);
    expect(spec.bootstrapSequence.map((step) => step.path)).toEqual(["/register"]);
    expect(spec.bootstrapSequence.map((step) => step.reason)).toEqual(["context-bootstrap"]);

    expect(spec.payloadExample).toEqual({
      email: "json.user@example.com",
      password: "***REDACTED***",
      profile: {
        nickname: "json-user",
        apiToken: "***REDACTED***",
      },
    });

    expect(spec.requiredHeaders).toMatchObject({
      "content-type": "application/json",
      origin: "https://app.local",
      referer: "https://app.local/register",
      accept: "application/json",
    });

    expect(spec.security.hasAuthorization).toBe(false);
    expect(spec.security.tokenHeaderNames).toEqual([]);
    expect(spec.csrfBootstrap.exists).toBe(false);

    expect(compatibility.registerEndpoint?.path).toBe("/api/register");
    expect(compatibility.csrfBootstrap.exists).toBe(false);
    expect(compatibility.security.hasAuthorization).toBe(false);
  });

  test("form submit payload keeps form mode and token redaction stable", async () => {
    const { spec, compatibility, harPath } = runExtractFromFixture("form-submit.har.json");
    assertBaseShape(spec, harPath);

    expect(spec.actionEndpoint?.method).toBe("POST");
    expect(spec.actionEndpoint?.path).toBe("/signup/submit");
    expect(spec.replayHints.bodyMode).toBe("form");
    expect(spec.replayHints.contentType).toBe("application/x-www-form-urlencoded");
    expect(spec.replayHints.successStatuses).toEqual([302]);
    expect(spec.bootstrapSequence.map((step) => step.path)).toEqual(["/signup"]);

    expect(spec.payloadExample).toEqual({
      email: "form.user@example.com",
      password: "***REDACTED***",
      plan: "pro",
      csrf_token: "***REDACTED***",
    });

    expect(spec.requiredHeaders).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://127.0.0.1:18080",
      referer: "http://127.0.0.1:18080/signup",
    });

    expect(spec.security.hasAuthorization).toBe(false);
    expect(spec.security.tokenHeaderNames).toEqual([]);
    expect(spec.csrfBootstrap.exists).toBe(false);

    expect(compatibility.registerEndpoint?.path).toBe("/signup/submit");
    expect(compatibility.csrfBootstrap.exists).toBe(false);
  });

  test("bootstrap token/cookie HAR preserves bootstrap and security boundaries", async () => {
    const { spec, compatibility, harPath } = runExtractFromFixture(
      "bootstrap-token-cookie.har.json",
    );
    assertBaseShape(spec, harPath);

    expect(spec.actionEndpoint?.method).toBe("POST");
    expect(spec.actionEndpoint?.path).toBe("/api/register");
    expect(spec.replayHints.bodyMode).toBe("json");
    expect(spec.replayHints.tokenHeaderNames).toEqual(["x-csrf-token"]);
    expect(
      spec.bootstrapSequence.map((step) => ({ path: step.path, reason: step.reason })),
    ).toEqual([
      { path: "/register", reason: "cookie-bootstrap" },
      { path: "/api/csrf-token", reason: "token-bootstrap" },
    ]);

    expect(spec.requiredHeaders).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer __fixture_bearer_token__",
      "x-csrf-token": "***DYNAMIC***",
    });
    expect(spec.requiredHeaders.cookie).toBeUndefined();

    expect(spec.security.hasAuthorization).toBe(true);
    expect(spec.security.tokenHeaderNames).toEqual(["x-csrf-token"]);
    expect(spec.security.cookieNames).toEqual(["session_id", "csrf_cookie", "theme"]);
    expect(spec.csrfBootstrap).toEqual({
      exists: true,
      fullUrl: "https://secure.local/api/csrf-token",
      path: "/api/csrf-token",
    });

    expect(spec.payloadExample).toEqual({
      email: "bootstrap.user@example.com",
      password: "***REDACTED***",
      otp: "***REDACTED***",
    });

    expect(compatibility.registerEndpoint?.path).toBe("/api/register");
    expect(compatibility.csrfBootstrap).toMatchObject({
      exists: true,
      path: "/api/csrf-token",
    });
    expect(compatibility.security.hasAuthorization).toBe(true);
  });
});
