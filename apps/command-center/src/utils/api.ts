export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type ApiRequestInit = RequestInit & {
  timeoutMs?: number;
};

type StructuredErrorBody = {
  detail?: unknown;
  message?: unknown;
  error?: unknown;
  rawText?: string;
};

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.includes("+json");
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toDiagnosticText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    const messageValue = (value as Record<string, unknown>).message;
    if (typeof messageValue === "string" && messageValue.trim().length > 0) {
      return messageValue;
    }
  }
  return undefined;
}

function buildErrorBody(text: string): StructuredErrorBody {
  const structured: StructuredErrorBody = {};
  if (text.length === 0) {
    return structured;
  }
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const parsedObject = parsed as Record<string, unknown>;
    if ("detail" in parsedObject) structured.detail = parsedObject.detail;
    if ("message" in parsedObject) structured.message = parsedObject.message;
    if ("error" in parsedObject) structured.error = parsedObject.error;
  }
  structured.rawText = text;
  return structured;
}

export async function readErrorDetail(
  response: Response,
): Promise<{ status: number; detail: string; requestId: string | null }> {
  const text = await response.text();
  const body = buildErrorBody(text);
  const detail =
    [
      toDiagnosticText(body.detail),
      toDiagnosticText(body.message),
      toDiagnosticText(body.error),
      body.rawText?.trim() || undefined,
      response.statusText.trim() || undefined,
      "unknown error",
    ].find((value) => value && value.length > 0) ?? "unknown error";
  const requestId = response.headers.get("x-request-id");
  return { status: response.status, detail, requestId };
}

export async function readSuccessPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!isJsonContentType(contentType)) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("API response is not valid JSON");
  }
}

export function mergeAbortSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  if (!externalSignal && timeoutMs <= 0) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (externalSignal && timeoutMs <= 0) {
    return { signal: externalSignal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const abortFromExternal = () => {
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  const timeoutHandle = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutHandle);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", abortFromExternal);
      }
    },
  };
}

export function formatApiError(
  action: string,
  error: { status: number; detail: string; requestId: string | null },
): string {
  const req = error.requestId ? `\uff0crequest_id=${error.requestId}` : "";
  return `${action}\uff1aHTTP ${error.status} - ${error.detail}${req}`;
}
