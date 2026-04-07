import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "tooling", "automation", "tests", "fixtures");

const BANNED_LEGACY_VALUE_PATTERN =
  /(StrongPass#2025|BootstrapPass#2025|FormPass%212025|test-token|boot-session-001|csrf-cookie-001|api-token-001|458271|form-token-002)/;
const SENSITIVE_KEY_PATTERN = /(password|token|otp|secret|authorization|cookie|csrf)/i;
const FIXTURE_PLACEHOLDER_PATTERN = /^__fixture_[a-z0-9_]+__$/;
const FIXTURE_BEARER_PATTERN = /^Bearer __fixture_[a-z0-9_]+__$/;

function listHarFixtures(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listHarFixtures(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".har.json")) {
      out.push(fullPath);
    }
  }
  return out;
}

function parseBody(postData) {
  if (!postData || typeof postData.text !== "string") {
    return null;
  }
  const mime = String(postData.mimeType || "").toLowerCase();
  if (mime.includes("application/json")) {
    try {
      const parsed = JSON.parse(postData.text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (mime.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(postData.text);
    return Object.fromEntries(params.entries());
  }
  return null;
}

function assertSensitiveValueSanitized(value, message) {
  assert.equal(
    FIXTURE_PLACEHOLDER_PATTERN.test(String(value)),
    true,
    `${message}: expected fixture placeholder, received "${String(value)}"`,
  );
}

test("HAR fixtures are sanitized and do not contain legacy credential samples", () => {
  const harFiles = listHarFixtures(FIXTURE_ROOT);
  assert.ok(harFiles.length > 0, "expected at least one HAR fixture");

  for (const filePath of harFiles) {
    const raw = readFileSync(filePath, "utf8");
    assert.equal(
      BANNED_LEGACY_VALUE_PATTERN.test(raw),
      false,
      `legacy sensitive sample found in ${path.relative(REPO_ROOT, filePath)}`,
    );

    const parsed = JSON.parse(raw);
    const entries = parsed?.log?.entries;
    assert.ok(Array.isArray(entries), `${path.relative(REPO_ROOT, filePath)} missing log.entries`);

    for (const entry of entries) {
      const requestHeaders = Array.isArray(entry?.request?.headers) ? entry.request.headers : [];
      for (const header of requestHeaders) {
        const name = String(header?.name || "").toLowerCase();
        const value = String(header?.value || "");
        if (name === "authorization") {
          assert.equal(
            FIXTURE_BEARER_PATTERN.test(value),
            true,
            `${path.relative(REPO_ROOT, filePath)} authorization header must use fixture bearer placeholder`,
          );
        }
        if (name === "x-csrf-token") {
          assertSensitiveValueSanitized(
            value,
            `${path.relative(REPO_ROOT, filePath)} x-csrf-token header`,
          );
        }
      }

      const responseHeaders = Array.isArray(entry?.response?.headers) ? entry.response.headers : [];
      const cookieLikeHeaders = [...requestHeaders, ...responseHeaders].filter((h) => {
        const name = String(h?.name || "").toLowerCase();
        return name === "cookie" || name === "set-cookie";
      });
      for (const header of cookieLikeHeaders) {
        const cookieParts = String(header?.value || "")
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean);
        for (const part of cookieParts) {
          const [key, ...rest] = part.split("=");
          if (!key || rest.length === 0) {
            continue;
          }
          const value = rest.join("=");
          if (SENSITIVE_KEY_PATTERN.test(key)) {
            assertSensitiveValueSanitized(
              value,
              `${path.relative(REPO_ROOT, filePath)} cookie field "${key}"`,
            );
          }
        }
      }

      const body = parseBody(entry?.request?.postData);
      if (!body) {
        continue;
      }
      for (const [key, value] of Object.entries(body)) {
        if (!SENSITIVE_KEY_PATTERN.test(key)) {
          continue;
        }
        assertSensitiveValueSanitized(
          value,
          `${path.relative(REPO_ROOT, filePath)} body field "${key}"`,
        );
      }
    }
  }
});
