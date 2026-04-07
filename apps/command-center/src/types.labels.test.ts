import { describe, expect, it } from "vitest";
import { RUN_RECORD_SOURCE_LABEL, UNIVERSAL_RUN_STATUS_LABEL } from "./types";

describe("run record labels", () => {
  it("keeps beginner-friendly source labels", () => {
    expect(RUN_RECORD_SOURCE_LABEL.command).toBe("Command run");
    expect(RUN_RECORD_SOURCE_LABEL.template).toBe("Template run");
  });

  it("keeps beginner-friendly status labels", () => {
    expect(UNIVERSAL_RUN_STATUS_LABEL.waiting_user).toBe("Waiting for user input");
    expect(UNIVERSAL_RUN_STATUS_LABEL.waiting_otp).toBe("Waiting for OTP");
    expect(UNIVERSAL_RUN_STATUS_LABEL.success).toBe("Succeeded");
    expect(UNIVERSAL_RUN_STATUS_LABEL.failed).toBe("Failed");
  });
});
