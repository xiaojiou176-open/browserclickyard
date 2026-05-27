// @ts-nocheck
// 
import assert from "node:assert/strict";
import test from "node:test";
import {
  redactSensitiveLine,
  redactSensitiveText,
  sanitizeProfileTarget,
  sanitizeRunId,
} from "../src/core/redaction.js";

test("sanitizeProfileTarget accepts valid trimmed values", () => {
  assert.equal(sanitizeProfileTarget("profile", "  smoke_profile-1  "), "smoke_profile-1");
  assert.equal(sanitizeProfileTarget("target", "api.target_2"), "api.target_2");
});

test("sanitizeProfileTarget rejects empty, absolute, traversal and invalid characters", () => {
  assert.throws(() => sanitizeProfileTarget("profile", "   "), /empty value/);
  assert.throws(() => sanitizeProfileTarget("target", "/tmp/file"), /absolute path/);
  assert.throws(() => sanitizeProfileTarget("target", "a/b"), /path separators/);
  assert.throws(() => sanitizeProfileTarget("target", "a\\b"), /path separators/);
  assert.throws(() => sanitizeProfileTarget("target", ".."), /path separators/);
  assert.throws(() => sanitizeProfileTarget("target", "../secret"), /path separators/);
  assert.throws(
    () => sanitizeProfileTarget("profile", "bad*name"),
    /only \[A-Za-z0-9._-\] allowed/,
  );
});

test("sanitizeRunId accepts valid trimmed values", () => {
  assert.equal(sanitizeRunId("  run-1_alpha.beta  "), "run-1_alpha.beta");
});

test("sanitizeRunId rejects empty values with explicit message", () => {
  assert.throws(
    () => sanitizeRunId("   "),
    (error: unknown) => error instanceof Error && error.message === "Invalid runId: empty value",
  );
});

test("sanitizeRunId rejects absolute path with explicit message", () => {
  assert.throws(
    () => sanitizeRunId("/tmp/run-a"),
    (error: unknown) =>
      error instanceof Error && error.message === "Invalid runId: absolute path is not allowed",
  );
});

test("sanitizeRunId rejects traversal markers with explicit message", () => {
  for (const value of ["a/b", "a\\b", "../run-a", ".."]) {
    assert.throws(
      () => sanitizeRunId(value),
      (error: unknown) =>
        error instanceof Error && error.message === "Invalid runId: path traversal is not allowed",
    );
  }
});

test("sanitizeRunId rejects invalid charset with explicit message", () => {
  assert.throws(
    () => sanitizeRunId("bad*name"),
    (error: unknown) =>
      error instanceof Error && error.message === "Invalid runId: only [A-Za-z0-9._-] allowed",
  );
});

test("redactSensitiveLine redacts bearer token, query params, json fields and env style secrets", () => {
  const bearerLine = "Authorization: Bearer abc123token";
  const basicLine = "Authorization: Basic dXNlcjpwYXNz";
  const headerLine = "X-API-Key: api-key-123";
  const automationHeaderLine = "X-Automation-Token: token-xyz";
  const vonageHeaderLine = "X-Vonage-Inbound-Token: token-123";
  const vonageLegacyHeaderLine = "X-Vonage-Token: token-legacy";
  const inboundLegacyHeaderLine = "X-Inbound-Token: token-legacy-2";
  const cookieLine = "Cookie: sessionid=abc123; csrftoken=def456";
  const queryLine = `GET /x${String.fromCharCode(63)}token=abc&password=p1&apikey=k2 HTTP/1.1`;
  const jsonLine =
    '{"accessToken":"abc","apiKey":"k","authorization":"Bearer abc","set-cookie":"sid=xyz","sig":"s1","signature":"s2"}';
  const envLine = "FOO_TOKEN=abc DB_PASSWORD=xyz";

  assert.equal(redactSensitiveLine(bearerLine), "Authorization: Bearer [REDACTED]");
  assert.equal(redactSensitiveLine(basicLine), "Authorization: Basic [REDACTED]");
  assert.equal(redactSensitiveLine(headerLine), "X-API-Key: [REDACTED]");
  assert.equal(redactSensitiveLine(automationHeaderLine), "X-Automation-Token: [REDACTED]");
  assert.equal(redactSensitiveLine(vonageHeaderLine), "X-Vonage-Inbound-Token: [REDACTED]");
  assert.equal(redactSensitiveLine(vonageLegacyHeaderLine), "X-Vonage-Token: [REDACTED]");
  assert.equal(redactSensitiveLine(inboundLegacyHeaderLine), "X-Inbound-Token: [REDACTED]");
  assert.equal(redactSensitiveLine(cookieLine), "Cookie: [REDACTED]");
  assert.equal(
    redactSensitiveLine(queryLine),
    `GET /x${String.fromCharCode(63)}token=[REDACTED]&password=[REDACTED]&apikey=[REDACTED] HTTP/1.1`,
  );
  assert.equal(
    redactSensitiveLine(jsonLine),
    '{"accessToken":"[REDACTED]","apiKey":"[REDACTED]","authorization":"[REDACTED]","set-cookie":"[REDACTED]","sig":"[REDACTED]","signature":"[REDACTED]"}',
  );
  assert.equal(redactSensitiveLine(envLine), "FOO_TOKEN=[REDACTED] DB_PASSWORD=[REDACTED]");
});

test("redactSensitiveLine enforces bearer token regex boundaries and spacing variants", () => {
  assert.equal(
    redactSensitiveLine("authorization:bearer abc123token"),
    "authorization:bearer [REDACTED]",
  );
  assert.equal(
    redactSensitiveLine("authorization:  bearer  abc123token"),
    "authorization:  bearer  [REDACTED]",
  );
  assert.equal(
    redactSensitiveLine("authorizationX: bearer abc123token"),
    "authorizationX: bearer abc123token",
  );
});

test("redactSensitiveLine redacts query and kv tokens at start and after whitespace only", () => {
  assert.equal(redactSensitiveLine("token=abc"), "token=[REDACTED]");
  assert.equal(redactSensitiveLine("prefix token=abc"), "prefix token=[REDACTED]");
  assert.equal(redactSensitiveLine("prefixXtoken=abc"), "prefixXtoken=abc");
});

test("redactSensitiveLine supports unquoted json-like key and env spaces around equals", () => {
  assert.equal(redactSensitiveLine('{token:"abc"}'), '{token:"[REDACTED]"}');
  assert.equal(
    redactSensitiveLine("prefix FOO_TOKEN=abc FOO_TOKEN =abc"),
    "prefix FOO_TOKEN=[REDACTED] FOO_TOKEN =[REDACTED]",
  );
  assert.equal(redactSensitiveLine("xTOKEN=abc"), "xTOKEN=abc");
});

test("redactSensitiveLine keeps non-sensitive text unchanged", () => {
  const input = "status=ok message=ready";
  assert.equal(redactSensitiveLine(input), input);
});

test("redactSensitiveText redacts line by line", () => {
  const input = [
    "Authorization: Bearer topsecret",
    '{"password":"open-sesame"}', // pragma: allowlist secret
    "plain line",
  ].join("\n");
  const expected = [
    "Authorization: Bearer [REDACTED]",
    '{"password":"[REDACTED]"}',
    "plain line",
  ].join("\n");
  assert.equal(redactSensitiveText(input), expected);
});
