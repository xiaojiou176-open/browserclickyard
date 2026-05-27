import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.BACKEND_PORT || 17380);

const command = {
  command_id: "script-pipeline-capture",
  title: "Real pipeline command",
  description: "Non-stub execution path used by frontend-e2e",
  tags: ["pipeline", "ui-only"],
  accepts_env: true,
};

const emptyFlowPreview = {
  session_id: null,
  start_url: null,
  generated_at: null,
  source_event_count: 0,
  step_count: 0,
  steps: [],
};

let sequence = 1;
const tasks = [];

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,x-automation-token,x-automation-client-id",
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${host}:${port}`);
  const path = requestUrl.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
      "access-control-allow-headers": "content-type,x-automation-token,x-automation-client-id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/api/automation/commands") {
    writeJson(res, 200, { commands: [command] });
    return;
  }
  if (req.method === "GET" && (path === "/health" || path === "/health/")) {
    writeJson(res, 200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && path === "/health/metrics") {
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
      "access-control-allow-headers": "content-type,x-automation-token,x-automation-client-id",
    });
    res.end(
      [
        "# HELP uiq_http_requests_total Total HTTP requests",
        "# TYPE uiq_http_requests_total counter",
        "uiq_http_requests_total 1",
        "# HELP uiq_automation_tasks Automation task counters",
        "# TYPE uiq_automation_tasks gauge",
        `uiq_automation_tasks{status="running"} ${tasks.filter((task) => task.status === "running").length}`,
        `uiq_automation_tasks{status="cancelled"} ${tasks.filter((task) => task.status === "cancelled").length}`,
      ].join("\n"),
    );
    return;
  }
  if (req.method === "GET" && path === "/api/automation/tasks") {
    const status = requestUrl.searchParams.get("status");
    const filtered =
      status && status !== "all" ? tasks.filter((task) => task.status === status) : tasks;
    writeJson(res, 200, { tasks: filtered });
    return;
  }
  if (req.method === "GET" && path === "/health/diagnostics") {
    writeJson(res, 200, {
      status: "ok",
      uptime_seconds: 1,
      task_counts: { queued: 0, running: 0, success: 0, failed: 0, cancelled: 0 },
      task_total: 0,
      metrics: {
        requests_total: 1,
        request_status: { "2xx": 1 },
        automation_runs: 0,
        automation_failures: 0,
        automation_cancellations: 0,
        rate_limited: 0,
      },
    });
    return;
  }
  if (req.method === "GET" && path === "/health/alerts") {
    writeJson(res, 200, { state: "ok", failure_rate: 0, threshold: 0.2, completed: 0, failed: 0 });
    return;
  }
  if (req.method === "GET" && path === "/api/command-tower/latest-flow") {
    writeJson(res, 200, emptyFlowPreview);
    return;
  }
  if (req.method === "GET" && path === "/api/command-tower/latest-flow-draft") {
    writeJson(res, 200, { session_id: null, flow: null });
    return;
  }
  if (req.method === "GET" && path === "/api/command-tower/evidence-timeline") {
    writeJson(res, 200, { items: [] });
    return;
  }
  if (req.method === "GET" && path === "/api/flows") {
    writeJson(res, 200, { flows: [] });
    return;
  }
  if (req.method === "GET" && path === "/api/templates") {
    writeJson(res, 200, { templates: [] });
    return;
  }
  if (req.method === "GET" && path === "/api/runs") {
    writeJson(res, 200, { runs: [] });
    return;
  }
  if (req.method === "POST" && path === "/api/automation/run") {
    const taskId = `ui-audit-task-${String(sequence).padStart(4, "0")}`;
    sequence += 1;
    const task = {
      task_id: taskId,
      command_id: "script-pipeline-capture",
      status: "running",
      requested_by: "ui-audit",
      attempt: 1,
      max_attempts: 1,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      message: "running",
      output_tail: "",
    };
    tasks.unshift(task);
    writeJson(res, 200, {
      task,
    });
    return;
  }
  if (
    req.method === "POST" &&
    path.startsWith("/api/automation/tasks/") &&
    path.endsWith("/cancel")
  ) {
    const taskId = decodeURIComponent(path.split("/")[4] || "");
    const target = tasks.find((item) => item.task_id === taskId);
    if (!target) {
      writeJson(res, 404, { detail: "task not found" });
      return;
    }
    target.status = "cancelled";
    target.finished_at = new Date().toISOString();
    target.message = "cancelled";
    writeJson(res, 200, target);
    return;
  }

  writeJson(res, 404, { detail: "not found" });
});

server.listen(port, host, () => {
  process.stdout.write(`[ui-audit-mock] listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
