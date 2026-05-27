import { describe, expect, it } from "vitest";
import { applyCounterAction, validateContactMessage } from "../../src/lib/state";

describe("state helpers", () => {
  it("increments/decrements with floor at zero", () => {
    expect(applyCounterAction(0, "increment")).toBe(1);
    expect(applyCounterAction(1, "decrement")).toBe(0);
    expect(applyCounterAction(0, "decrement")).toBe(0);
    expect(applyCounterAction(42, "reset")).toBe(0);
  });

  it("validates contact payload", () => {
    expect(validateContactMessage("A", "short")).toContain("Name");
    expect(validateContactMessage("Alex", "short")).toContain("Message");
    expect(validateContactMessage("Alex", "a long enough message")).toBeNull();
  });
});
