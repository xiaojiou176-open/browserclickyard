import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type HarHeader = { name: string; value: string };

type HarEntry = {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers?: HarHeader[];
    postData?: {
      mimeType?: string;
      text?: string;
    };
  };
  response: {
    status: number;
    headers?: HarHeader[];
  };
};

type HarDocument = {
  log: {
    entries: HarEntry[];
  };
};

type EndpointSpec = {
  method: string;
  fullUrl: string;
  path: string;
  contentType: string | null;
};

type BootstrapStep = {
  method: string;
  fullUrl: string;
  path: string;
  reason: string;
};

type FlowRequestSpec = {
  generatedAt: string;
  sourceHarPath: string;
  baseUrl: string;
  actionEndpoint: EndpointSpec | null;
  bootstrapSequence: BootstrapStep[];
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
  registerEndpoint: EndpointSpec | null;
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

const RUNTIME_ROOT = path.resolve(process.cwd(), "..", ".runtime-cache", "automation");

function getHeader(headers: HarHeader[] | undefined, target: string): string | null {
  if (!headers) {
    return null;
  }
  const hit = headers.find((header) => header.name.toLowerCase() === target.toLowerCase());
  return hit ? hit.value : null;
}

function parseCookieNames(cookieHeader: string | null): string[] {
  if (!cookieHeader) {
    return [];
  }
  const names = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.split("=")[0]?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(names)];
}

function parseSetCookieNames(headers: HarHeader[] | undefined): string[] {
  if (!headers) {
    return [];
  }
  const names: string[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== "set-cookie") {
      continue;
    }
    const key = header.value.split(";")[0]?.split("=")[0]?.trim();
    if (key) {
      names.push(key);
    }
  }
  return [...new Set(names)];
}

function isStaticAsset(pathname: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|ico|css|js|mjs|woff2?|ttf|map|webp|mp4|mov|avi)$/i.test(pathname);
}

function actionKeywordScore(pathname: string): number {
  const lower = pathname.toLowerCase();
  let score = 0;
  const highValueKeywords = [
    "register",
    "signup",
    "sign-up",
    "create",
    "submit",
    "auth",
    "account",
    "user",
    "onboard",
  ];
  for (const keyword of highValueKeywords) {
    if (lower.includes(keyword)) {
      score += 8;
    }
  }
  if (lower.includes("graphql")) {
    score += 6;
  }
  return score;
}

function scoreActionCandidate(entry: HarEntry, preferredHost: string | null): number {
  const method = entry.request.method.toUpperCase();
  const url = new URL(entry.request.url);
  const pathname = url.pathname;
  const status = entry.response.status;
  const hasBody = Boolean(entry.request.postData?.text?.trim());
  let score = 0;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    score += 60;
  }
  if (method === "GET") {
    score += 5;
  }
  if (hasBody) {
    score += 20;
  }
  if (status >= 200 && status < 400) {
    score += 10;
  }
  if (preferredHost && url.host === preferredHost) {
    score += 8;
  }
  score += actionKeywordScore(pathname);
  if (isStaticAsset(pathname)) {
    score -= 40;
  }
  if (pathname === "/" || pathname.length <= 1) {
    score -= 10;
  }
  return score;
}

function pickPrimaryAction(entries: HarEntry[]): HarEntry | null {
  if (entries.length === 0) {
    return null;
  }
  const latestEntry =
    [...entries]
      .sort((a, b) => new Date(a.startedDateTime).getTime() - new Date(b.startedDateTime).getTime())
      .at(-1) ?? null;
  const preferredHost = latestEntry ? new URL(latestEntry.request.url).host : null;
  const ranked = entries
    .map((entry) => ({
      entry,
      score: scoreActionCandidate(entry, preferredHost),
      ts: new Date(entry.startedDateTime).getTime(),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.ts - a.ts;
    });
  return ranked.at(0)?.entry ?? null;
}

function parsePayload(entry: HarEntry | null): Record<string, unknown> {
  if (!entry) {
    return {};
  }
  const raw = entry.request.postData?.text;
  if (!raw) {
    return {};
  }
  const mimeType = (entry.request.postData?.mimeType ?? "").toLowerCase();
  if (mimeType.includes("application/json")) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { rawBody: raw };
    }
  }
  if (mimeType.includes("application/x-www-form-urlencoded")) {
    const parsed: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      parsed[key] = value;
    }
    return parsed;
  }
  return { rawBody: raw };
}

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  return /(^|_)(password|passwd|secret|token|authorization|cookie|session|otp|code)($|_)/.test(
    normalized,
  );
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (isSensitiveKey(key)) {
    return "***REDACTED***";
  }
  return value;
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizePayload(value as Record<string, unknown>);
      continue;
    }
    out[key] = sanitizeValue(key, value);
  }
  return out;
}

function inferBodyMode(contentType: string | null): "json" | "form" | "raw" | "none" {
  if (!contentType) {
    return "none";
  }
  const lower = contentType.toLowerCase();
  if (lower.includes("application/json")) {
    return "json";
  }
  if (lower.includes("application/x-www-form-urlencoded")) {
    return "form";
  }
  return "raw";
}

function detectBootstrapSequence(
  entries: HarEntry[],
  actionEntry: HarEntry | null,
): BootstrapStep[] {
  if (!actionEntry) {
    return [];
  }
  const actionTs = new Date(actionEntry.startedDateTime).getTime();
  const actionHost = new URL(actionEntry.request.url).host;
  const candidates = entries
    .filter((entry) => new Date(entry.startedDateTime).getTime() <= actionTs)
    .filter((entry) => {
      const url = new URL(entry.request.url);
      if (url.host !== actionHost) {
        return false;
      }
      if (entry === actionEntry) {
        return false;
      }
      const pathname = url.pathname.toLowerCase();
      const hasTokenHint = /(csrf|xsrf|token|session|challenge|captcha|otp|verify|auth)/.test(
        pathname,
      );
      const hasSetCookie = (entry.response.headers ?? []).some(
        (header) => header.name.toLowerCase() === "set-cookie",
      );
      const isDocGet = entry.request.method.toUpperCase() === "GET" && pathname.length <= 64;
      return hasTokenHint || hasSetCookie || isDocGet;
    })
    .map((entry) => {
      const url = new URL(entry.request.url);
      const pathname = url.pathname;
      const reason = /(csrf|xsrf|token)/i.test(pathname)
        ? "token-bootstrap"
        : /(captcha|challenge|turnstile|verify)/i.test(pathname)
          ? "protection-bootstrap"
          : (entry.response.headers ?? []).some(
                (header) => header.name.toLowerCase() === "set-cookie",
              )
            ? "cookie-bootstrap"
            : "context-bootstrap";
      return {
        step: {
          method: entry.request.method.toUpperCase(),
          fullUrl: entry.request.url,
          path: pathname,
          reason,
        } satisfies BootstrapStep,
        ts: new Date(entry.startedDateTime).getTime(),
      };
    })
    .sort((a, b) => a.ts - b.ts);
  return candidates.slice(-3).map((item) => item.step);
}

function collectRequiredHeaders(entry: HarEntry | null): Record<string, string> {
  if (!entry) {
    return {};
  }
  const requiredHeaders: Record<string, string> = {};
  const headers = entry.request.headers ?? [];
  for (const header of headers) {
    const key = header.name.toLowerCase();
    if (["content-type", "origin", "referer", "authorization", "accept"].includes(key)) {
      requiredHeaders[key] = header.value;
      continue;
    }
    if (key.startsWith("x-") && /(csrf|xsrf|token|sentinel|nonce|device)/i.test(key)) {
      requiredHeaders[key] = "***DYNAMIC***";
    }
  }
  return requiredHeaders;
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function resolveHarPath(): Promise<string> {
  const argHar = process.argv.find((arg) => arg.startsWith("--har="));
  if (argHar) {
    return path.resolve(process.cwd(), argHar.slice("--har=".length));
  }
  const latest = await readJson<{ sessionDir: string }>(
    path.join(RUNTIME_ROOT, "latest-session.json"),
  );
  return path.join(latest.sessionDir, "register.har");
}

async function main(): Promise<void> {
  const harPath = await resolveHarPath();
  const har = await readJson<HarDocument>(harPath);
  const entries = har.log.entries ?? [];
  const actionEntry = pickPrimaryAction(entries);
  const actionUrl = actionEntry ? new URL(actionEntry.request.url) : null;
  const baseUrl = actionUrl ? `${actionUrl.protocol}//${actionUrl.host}` : "";
  const payloadExample = sanitizePayload(parsePayload(actionEntry));
  const requiredHeaders = collectRequiredHeaders(actionEntry);
  const bootstrapSequence = detectBootstrapSequence(entries, actionEntry);
  const headerTokenNames = Object.keys(requiredHeaders).filter((header) =>
    /(csrf|xsrf|token|sentinel)/i.test(header),
  );
  const cookieNames = [
    ...parseCookieNames(getHeader(actionEntry?.request.headers, "cookie")),
    ...bootstrapSequence.flatMap((step) => {
      const matched = entries.find((entry) => entry.request.url === step.fullUrl);
      return parseSetCookieNames(matched?.response.headers);
    }),
  ];
  const uniqueCookieNames = [...new Set(cookieNames)];
  const contentType = getHeader(actionEntry?.request.headers, "content-type");
  const actionStatus = actionEntry?.response.status;
  const successStatuses =
    actionStatus && actionStatus >= 200 && actionStatus < 400 ? [actionStatus] : [200, 201];
  const actionEndpoint: EndpointSpec | null =
    actionEntry && actionUrl
      ? {
          method: actionEntry.request.method.toUpperCase(),
          fullUrl: actionEntry.request.url,
          path: actionUrl.pathname,
          contentType,
        }
      : null;

  const csrfBootstrap = bootstrapSequence.find((step) => /(csrf|xsrf|token)/i.test(step.path));

  const requests = entries.map((entry) => {
    const entryUrl = new URL(entry.request.url);
    return {
      startedAt: entry.startedDateTime,
      method: entry.request.method.toUpperCase(),
      url: entry.request.url,
      path: entryUrl.pathname,
      status: entry.response.status,
    };
  });

  const spec: FlowRequestSpec = {
    generatedAt: new Date().toISOString(),
    sourceHarPath: harPath,
    baseUrl,
    actionEndpoint,
    bootstrapSequence,
    replayHints: {
      bodyMode: inferBodyMode(contentType),
      contentType,
      tokenHeaderNames: headerTokenNames,
      successStatuses,
    },
    security: {
      tokenHeaderNames: headerTokenNames,
      cookieNames: uniqueCookieNames,
      hasAuthorization: Boolean(requiredHeaders.authorization),
    },
    registerEndpoint: actionEndpoint,
    csrfBootstrap: {
      exists: Boolean(csrfBootstrap),
      fullUrl: csrfBootstrap?.fullUrl ?? null,
      path: csrfBootstrap?.path ?? null,
    },
    requiredHeaders,
    payloadExample,
    requests,
  };

  const targetDir = path.dirname(harPath);
  const canonicalPath = path.join(targetDir, "flow_request.spec.json");
  await writeFile(canonicalPath, JSON.stringify(spec, null, 2), "utf-8");

  if (spec.registerEndpoint) {
    const compatibilitySpec = {
      generatedAt: spec.generatedAt,
      sourceHarPath: spec.sourceHarPath,
      baseUrl: spec.baseUrl,
      registerEndpoint: spec.registerEndpoint,
      csrfBootstrap: spec.csrfBootstrap,
      requiredHeaders: spec.requiredHeaders,
      payloadExample: spec.payloadExample,
      actionEndpoint: spec.actionEndpoint,
      bootstrapSequence: spec.bootstrapSequence,
      replayHints: spec.replayHints,
      security: spec.security,
    };
    await writeFile(
      path.join(targetDir, "register_request.spec.json"),
      JSON.stringify(compatibilitySpec, null, 2),
      "utf-8",
    );
  }

  await writeFile(
    path.join(RUNTIME_ROOT, "latest-spec.json"),
    JSON.stringify({ specPath: canonicalPath }, null, 2),
    "utf-8",
  );
  process.stdout.write(
    `${JSON.stringify({ canonicalPath, requestCount: spec.requests.length, actionPath: spec.actionEndpoint?.path ?? null }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`extract-flow-spec failed: ${message}\n`);
  process.exitCode = 1;
});
