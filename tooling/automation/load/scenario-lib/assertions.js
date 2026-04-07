import { check, fail } from "k6";

export function assertChecks(subject, checks, failureMessage) {
  const passed = check(subject, checks);
  if (!passed) {
    fail(failureMessage);
  }
}

export function parseJsonBody(response, label) {
  try {
    return response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`${label}: response body is not valid JSON (${message})`);
    return null;
  }
}

export function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

export function assertBodyIncludes(body, needle, label) {
  if (typeof body !== "string" || !body.includes(needle)) {
    fail(`${label}: expected body to contain "${needle}"`);
  }
}
