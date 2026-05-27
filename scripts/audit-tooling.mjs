#!/usr/bin/env node
// @ts-nocheck
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXCEPTIONS_PATH = resolve("configs/security/tooling-audit-exceptions.json");

function parseAuditOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("Unable to locate JSON payload from `pnpm audit --json` output.");
  }
  return JSON.parse(text.slice(firstBrace));
}

function loadExceptions() {
  const raw = readFileSync(EXCEPTIONS_PATH, "utf8");
  const payload = JSON.parse(raw);
  const map = new Map();
  for (const item of payload.exceptions ?? []) {
    if (!item?.id) {
      continue;
    }
    map.set(String(item.id), item);
  }
  return map;
}

function collectHighAndCritical(payload) {
  return Object.values(payload.advisories ?? {}).filter((advisory) => {
    const severity = String(advisory.severity ?? "").toLowerCase();
    return severity === "high" || severity === "critical";
  });
}

function runAuditJson() {
  try {
    return execSync("pnpm audit --audit-level=high --json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return String(error.stdout ?? error.message ?? "");
  }
}

function isValidException(advisory, exception) {
  if (!exception) {
    return { ok: false, reason: "missing_exception" };
  }
  if (!exception.ticket || !exception.expiresOn) {
    return { ok: false, reason: "missing_ticket_or_expiry" };
  }
  const expiry = Date.parse(`${exception.expiresOn}T23:59:59Z`);
  if (Number.isNaN(expiry)) {
    return { ok: false, reason: "invalid_expiry" };
  }
  if (expiry < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (exception.package && exception.package !== advisory.module_name) {
    return { ok: false, reason: "package_mismatch" };
  }
  return { ok: true, reason: "allowed" };
}

function advisoryId(advisory) {
  return String(advisory.github_advisory_id ?? advisory.id);
}

function main() {
  const payload = parseAuditOutput(runAuditJson());
  const highAndCritical = collectHighAndCritical(payload);

  if (highAndCritical.length === 0) {
    return;
  }

  const exceptions = loadExceptions();
  const blocked = [];
  const exempted = [];

  for (const advisory of highAndCritical) {
    const id = advisoryId(advisory);
    const exception = exceptions.get(id);
    const validation = isValidException(advisory, exception);
    if (validation.ok) {
      exempted.push({
        id,
        package: advisory.module_name,
        severity: advisory.severity,
        ticket: exception.ticket,
        expiresOn: exception.expiresOn,
      });
      continue;
    }
    blocked.push({
      id,
      package: advisory.module_name,
      severity: advisory.severity,
      reason: validation.reason,
    });
  }

  if (exempted.length > 0) {
    for (const _item of exempted) {
    }
  }

  if (blocked.length > 0) {
    for (const _item of blocked) {
    }
    process.exit(1);
  }
}

main();
