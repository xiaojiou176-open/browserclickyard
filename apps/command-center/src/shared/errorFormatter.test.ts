import { describe, expect, it } from "vitest";
import { formatActionableErrorMessage } from "./errorFormatter";

describe("formatActionableErrorMessage", () => {
  it("returns empty string when message is blank", () => {
    const result = formatActionableErrorMessage("   ", {
      action: "Retry",
      troubleshootingEntry: "/logs",
    });

    expect(result).toBe("");
  });

  it("returns original message when structured tokens already exist", () => {
    const structured = "Conclusion: API failed. Action: Refresh the page. Troubleshooting entry: /trace/1";

    expect(
      formatActionableErrorMessage(structured, {
        action: "Ignore",
        troubleshootingEntry: "/unused",
      }),
    ).toBe(structured);
  });

  it("formats unstructured message with action and troubleshooting info", () => {
    const result = formatActionableErrorMessage("Request timed out", {
      action: "Check the network and retry",
      troubleshootingEntry: "/ops/network",
    });

    expect(result).toBe(
      "Conclusion: Request timed out. Action: Check the network and retry. Troubleshooting entry: /ops/network",
    );
  });
});
