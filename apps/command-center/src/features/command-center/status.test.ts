import { describe, expect, it } from "vitest";
import { isCancelableStatus } from "./status";

describe("isCancelableStatus", () => {
  it("returns true only for queued and running", () => {
    expect(isCancelableStatus("queued")).toBe(true);
    expect(isCancelableStatus("running")).toBe(true);
    expect(isCancelableStatus("success")).toBe(false);
    expect(isCancelableStatus("failed")).toBe(false);
    expect(isCancelableStatus("cancelled")).toBe(false);
  });
});
