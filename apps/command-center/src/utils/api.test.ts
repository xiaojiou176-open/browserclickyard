import { afterEach, describe, expect, it, vi } from "vitest";
import { formatApiError, mergeAbortSignal, readErrorDetail, readSuccessPayload } from "./api";

describe("api utils", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats api error with request id", () => {
    const message = formatApiError("Load failed", {
      status: 403,
      detail: "denied",
      requestId: "req_1",
    });
    expect(message).toContain("HTTP 403");
    expect(message).toContain("request_id=req_1");
  });

  it("reads error detail from response json payload", async () => {
    const response = new Response(JSON.stringify({ detail: "bad request" }), {
      status: 400,
      headers: { "x-request-id": "req_2", "content-type": "application/json" },
    });
    const detail = await readErrorDetail(response);
    expect(detail.status).toBe(400);
    expect(detail.detail).toBe("bad request");
    expect(detail.requestId).toBe("req_2");
  });

  it("uses raw text detail when error body is non-JSON text", async () => {
    const response = new Response("not-json", {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "x-request-id": "req_3", "content-type": "text/plain" },
    });
    const detail = await readErrorDetail(response);
    expect(detail.status).toBe(500);
    expect(detail.detail).toBe("not-json");
    expect(detail.requestId).toBe("req_3");
  });

  it("returns undefined for empty successful response body", async () => {
    const response = new Response(null, { status: 204 });
    await expect(readSuccessPayload(response)).resolves.toBeUndefined();
  });

  it("returns text for successful non-JSON response body", async () => {
    const response = new Response("plain text", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    await expect(readSuccessPayload(response)).resolves.toBe("plain text");
  });

  it("throws on malformed JSON when content-type is JSON", async () => {
    const response = new Response("{bad", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(readSuccessPayload(response)).rejects.toThrow("API response is not valid JSON");
  });

  it("aborts with timeout reason via mergeAbortSignal", async () => {
    vi.useFakeTimers();
    const { signal, cleanup } = mergeAbortSignal(10);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(11);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(Error);
    expect((signal?.reason as Error).message).toContain("Request timed out after 10ms");
    cleanup();
  });
});
