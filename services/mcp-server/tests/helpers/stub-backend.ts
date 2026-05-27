// @ts-nocheck
// 
//
import http from "node:http";

export type StubBackend = {
  baseUrl: string;
  getStats: () => {
    otpSubmitCount: number;
    receivedOtpCodes: string[];
    runGetCount: number;
  };
  close: () => Promise<void>;
};

export async function startStubBackend(options?: {
  requireToken?: boolean;
  acceptedToken?: string;
  commandsStatus?: number;
  delayMs?: number;
  runStatusSequence?: string[];
  otpSuccessStatus?: string;
}): Promise<StubBackend> {
  const requireToken = options?.requireToken ?? false;
  const acceptedToken = options?.acceptedToken ?? "token-1";
  const commandsStatus = options?.commandsStatus ?? 200;
  const delayMs = options?.delayMs ?? 0;
  const runStatusSequence = options?.runStatusSequence ?? ["success"];
  const otpSuccessStatus = options?.otpSuccessStatus ?? "success";
  let runStatusIndex = 0;
  let otpSubmitCount = 0;
  let runGetCount = 0;
  const receivedOtpCodes: string[] = [];

  const currentRunStatus = (): string =>
    runStatusSequence[Math.min(runStatusIndex, runStatusSequence.length - 1)] ?? "success";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = req.headers["x-automation-token"];

    const reject401 = () => {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ detail: "invalid automation token" }));
    };

    if (requireToken && token !== acceptedToken) {
      reject401();
      return;
    }

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const writeJson = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };

    const readJsonBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (chunks.length === 0) {
        return {};
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        return {};
      }
      return JSON.parse(text) as Record<string, unknown>;
    };

    if (req.method === "GET" && url.pathname === "/health/") {
      writeJson(200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/commands") {
      if (commandsStatus !== 200) {
        writeJson(commandsStatus, { detail: "backend failure" });
        return;
      }
      writeJson(200, {
        commands: [{ command_id: "script-pipeline-full", title: "Run", description: "fixture", tags: [] }],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/tasks") {
      writeJson(200, { tasks: [] });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flows") {
      writeJson(200, { items: [] });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/templates") {
      writeJson(200, { items: [] });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/runs") {
      writeJson(200, {
        runs: [
          {
            run_id: "run-1",
            status: "waiting_user",
            wait_context: {
              reason_code: "provider_protected_payment_step",
              screen_title: "Manual verification required",
              allowed_resume_kinds: ["approval"],
            },
          },
        ],
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/runs") {
      writeJson(200, { run_id: "run-1", status: currentRunStatus() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/runs/run-1") {
      runGetCount += 1;
      const status = currentRunStatus();
      if (runStatusIndex < runStatusSequence.length - 1) {
        runStatusIndex += 1;
      }
      writeJson(200, { run_id: "run-1", status });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/runs/run-1/otp") {
      const body = await readJsonBody();
      otpSubmitCount += 1;
      if (typeof body.otp_code === "string") {
        receivedOtpCodes.push(body.otp_code);
      }
      runStatusIndex = runStatusSequence.indexOf(otpSuccessStatus);
      if (runStatusIndex < 0) {
        runStatusIndex = runStatusSequence.length - 1;
      }
      writeJson(200, { run_id: "run-1", status: otpSuccessStatus });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/proof/runs/compare") {
      writeJson(200, {
        left_run_id: "run-1",
        right_run_id: "run-2",
        metrics_delta: {
          values: {
            fcp: 120,
            lcp: 260,
          },
        },
        checks: {
          added_failed_or_blocked: [],
          removed_failed_or_blocked: [],
          persisted_failed_or_blocked: [],
        },
        summary: {},
      });
      return;
    }

    const aiReviewMatch = url.pathname.match(/^\/api\/proof\/runs\/([^/]+)\/ai-review$/);
    if (req.method === "GET" && aiReviewMatch) {
      const requestedRunId = decodeURIComponent(aiReviewMatch[1] ?? "run-1");
      writeJson(200, {
        run_id: requestedRunId,
        enabled: true,
        report_path: "reports/ai-review.json",
        findings: [{ id: "finding-1", severity: "high" }],
        summary: { totalFindings: 1, highOrAbove: 1 },
        generation: { model: "models/gemini-3.1-pro-preview" },
      });
      return;
    }

    const releaseBriefMatch = url.pathname.match(/^\/api\/proof\/runs\/([^/]+)\/release-brief$/);
    if (req.method === "GET" && releaseBriefMatch) {
      const requestedRunId = decodeURIComponent(releaseBriefMatch[1] ?? "run-1");
      writeJson(200, {
        run_id: requestedRunId,
        baseline_run_id: null,
        recommendation: "review-ready",
        gate_status: "passed",
        observed: { failed_check_count: 0 },
        ai_interpretation: { findings_total: 1, high_or_above: 1 },
        evidence_snapshot: { report_paths: { summary: "reports/summary.json" } },
        open_questions: [],
        next_step: "Review the evidence snapshot and confirm the next operator decision.",
      });
      return;
    }

    const similarFailuresMatch = url.pathname.match(/^\/api\/proof\/runs\/([^/]+)\/similar-failures$/);
    if (req.method === "GET" && similarFailuresMatch) {
      const requestedRunId = decodeURIComponent(similarFailuresMatch[1] ?? "run-1");
      writeJson(200, {
        run_id: requestedRunId,
        matches: [
          {
            run_id: "run-near",
            score: 0.91,
            gate_status: "failed",
            reason_codes: ["gate.perf_lcp_ms_max.failed.threshold_exceeded"],
            summary: {},
            why_matched: "Shared failure reason.",
            report_path: "reports/summary.json",
          },
        ],
      });
      return;
    }

    const feasibilityMatch = url.pathname.match(/^\/api\/proof\/templates\/([^/]+)\/feasibility$/);
    if (req.method === "GET" && feasibilityMatch) {
      const requestedTemplateId = decodeURIComponent(feasibilityMatch[1] ?? "template-1");
      writeJson(200, {
        template_id: requestedTemplateId,
        target: url.searchParams.get("target") ?? "web.local",
        supported: false,
        blocked_reasons: ["navigate is not supported on this target"],
        migration_hints: ["fork the template and replace the navigate step"],
        required_capabilities: ["navigate"],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/proof/campaigns") {
      writeJson(200, {
        campaigns: [
          {
            campaign_id: "campaign-1",
            model: "proof-v1",
            status: "passed",
            policy_mode: "strict",
            run_ids: ["run-a"],
            reason_codes: [],
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            report_path: ".runtime-cache/artifacts/proof-campaigns/campaign-1/campaign.report.json",
            index_path: ".runtime-cache/artifacts/proof-campaigns/campaign-1/campaign.index.json",
          },
        ],
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/proof/campaigns") {
      const body = await readJsonBody();
      writeJson(200, {
        campaign: {
          campaign_id: "campaign-created",
          model: typeof body.model === "string" ? body.model : "proof-v1",
          name: typeof body.name === "string" ? body.name : null,
          description: typeof body.description === "string" ? body.description : null,
          status: "passed",
          policy_mode: "strict",
          run_ids: Array.isArray(body.run_ids) ? body.run_ids : [],
          reason_codes: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          report_path: ".runtime-cache/artifacts/proof-campaigns/campaign-created/campaign.report.json",
          index_path: ".runtime-cache/artifacts/proof-campaigns/campaign-created/campaign.index.json",
        },
        report: {
          campaignId: "campaign-created",
          model: typeof body.model === "string" ? body.model : "proof-v1",
          ok: true,
          policyMode: "strict",
          reasonCodes: [],
          stats: { runCount: Array.isArray(body.run_ids) ? body.run_ids.length : 0 },
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/proof/campaigns/campaign-1") {
      writeJson(200, {
        campaign: {
          campaign_id: "campaign-1",
          model: "proof-v1",
          status: "passed",
          policy_mode: "strict",
          run_ids: ["run-a"],
          reason_codes: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          report_path: ".runtime-cache/artifacts/proof-campaigns/campaign-1/campaign.report.json",
          index_path: ".runtime-cache/artifacts/proof-campaigns/campaign-1/campaign.index.json",
        },
        report: {
          campaignId: "campaign-1",
          model: "proof-v1",
          ok: true,
          policyMode: "strict",
          reasonCodes: [],
          runIds: ["run-a"],
          stats: { runCount: 1 },
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/proof/campaigns/campaign-1/diff") {
      writeJson(200, {
        left_campaign_id: "campaign-1",
        right_campaign_id: "campaign-2",
        diff: {
          campaignA: "campaign-1",
          campaignB: "campaign-2",
          delta: { runCount: 1 },
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/start") {
      const body = await readJsonBody();
      writeJson(200, {
        session_id: "session-1",
        start_url: typeof body.start_url === "string" ? body.start_url : null,
        mode: typeof body.mode === "string" ? body.mode : null,
      });
      return;
    }

    writeJson(404, { detail: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stub backend address unavailable");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getStats: () => ({
      otpSubmitCount,
      receivedOtpCodes: [...receivedOtpCodes],
      runGetCount,
    }),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
