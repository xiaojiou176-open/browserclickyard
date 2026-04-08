#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

function loadYaml(filePath) {
  return YAML.parse(readFileSync(resolve(filePath), "utf8"));
}

function normalizeNeeds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function asSet(items) {
  return new Set(items.map((item) => String(item)));
}

function sameMembers(left, right) {
  const a = asSet(left);
  const b = asSet(right);
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

function renderList(items) {
  return items.join(", ");
}

function loadWorkflowJobs(workflowPath) {
  const workflow = loadYaml(workflowPath);
  return workflow?.jobs ?? {};
}

function collectRequiredJobs(config) {
  const result = [];
  for (const scope of ["ci", "pr", "nightly"]) {
    for (const jobName of config.required_jobs?.[scope] ?? []) {
      const workflowPath =
        scope === "ci" || scope === "pr"
          ? config.aggregates?.[scope]?.workflow
          : `.github/workflows/${scope}.yml`;
      result.push({ workflowPath, jobName, scope });
    }
  }
  return result;
}

function checkAllowedContinueOnErrorSteps(config, failures) {
  const allowMap = config.policy_flags?.allowed_continue_on_error_steps ?? {};
  const requiredJobs = collectRequiredJobs(config);
  for (const { workflowPath, jobName, scope } of requiredJobs) {
    const jobs = loadWorkflowJobs(workflowPath);
    const job = jobs[jobName];
    if (!job) {
      continue;
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const allowedSteps = new Set(
      Array.isArray(allowMap?.[workflowPath]?.[jobName]) ? allowMap[workflowPath][jobName] : [],
    );
    for (const step of steps) {
      if (step?.["continue-on-error"] !== true) {
        continue;
      }
      const stepName = String(step?.name ?? "").trim() || "<unnamed-step>";
      if (!allowedSteps.has(stepName)) {
        failures.push(
          `required workflow contains non-allowlisted continue-on-error step: scope=${scope} workflow=${workflowPath} job=${jobName} step=${stepName}`,
        );
      }
    }
  }
}

function main() {
  const config = loadYaml("configs/governance/ci-governance.yaml");
  const failures = [];

  for (const scope of ["ci", "pr"]) {
    const aggregate = config.aggregates?.[scope];
    const requiredJobs = config.required_jobs?.[scope] ?? [];
    const jobs = loadWorkflowJobs(aggregate.workflow);
    const aggregateJob = jobs[aggregate.job];
    if (!aggregateJob) {
      failures.push(`missing aggregate job: scope=${scope} workflow=${aggregate.workflow} job=${aggregate.job}`);
      continue;
    }

    const actualNeeds = normalizeNeeds(aggregateJob.needs);
    if (!sameMembers(actualNeeds, requiredJobs)) {
      failures.push(
        `aggregate needs mismatch: scope=${scope} job=${aggregate.job} expected=[${renderList(requiredJobs)}] actual=[${renderList(actualNeeds)}]`,
      );
    }

    for (const jobName of requiredJobs) {
      if (!jobs[jobName]) {
        failures.push(
          `required job missing from workflow: scope=${scope} workflow=${aggregate.workflow} job=${jobName}`,
        );
      }
    }

    for (const optionalJob of config.optional_jobs?.[scope]?.jobs ?? []) {
      if (actualNeeds.includes(optionalJob)) {
        failures.push(
          `optional job must not be required by aggregate: scope=${scope} aggregate=${aggregate.job} optional=${optionalJob}`,
        );
      }
    }
  }

  for (const scope of ["nightly"]) {
    const workflowPath = `.github/workflows/${scope}.yml`;
    const jobs = loadWorkflowJobs(workflowPath);
    for (const jobName of config.required_jobs?.[scope] ?? []) {
      if (!jobs[jobName]) {
        failures.push(`required job missing from workflow: scope=${scope} workflow=${workflowPath} job=${jobName}`);
      }
    }
    for (const jobName of config.optional_jobs?.[scope]?.jobs ?? []) {
      if (!jobs[jobName]) {
        failures.push(`optional job missing from workflow: scope=${scope} workflow=${workflowPath} job=${jobName}`);
      }
    }
  }

  for (const [featureName, feature] of Object.entries(config.features ?? {})) {
    const jobs = loadWorkflowJobs(feature.workflow);
    const exists = Boolean(jobs[feature.job]);
    if (feature.status === "disabled" && exists) {
      failures.push(`disabled feature job must not exist: feature=${featureName} workflow=${feature.workflow} job=${feature.job}`);
    }
    if (feature.status === "enabled" && !exists) {
      failures.push(`enabled feature job missing: feature=${featureName} workflow=${feature.workflow} job=${feature.job}`);
    }
  }

  checkAllowedContinueOnErrorSteps(config, failures);

  if (failures.length > 0) {
    console.error(`[workflow-topology-sync] FAIL (${failures.length} issue(s))`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("[workflow-topology-sync] PASS");
}

main();
