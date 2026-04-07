import { describe, expect, it } from "vitest";
import { isFirstUseConfigValid } from "./useAppStore";

describe("isFirstUseConfigValid", () => {
  it("accepts valid baseUrl and defaultable startUrl", () => {
    expect(
      isFirstUseConfigValid({
        baseUrl: "http://127.0.0.1:17380",
        startUrl: "",
        successSelector: "#ok",
        modelName: "models/gemini-3.1-pro-preview",
        registerPassword: "",
        automationToken: "",
        automationClientId: "client-001",
        headless: false,
        midsceneStrict: false,
      }),
    ).toBe(true);
  });

  it("rejects invalid baseUrl protocol", () => {
    expect(
      isFirstUseConfigValid({
        baseUrl: "ftp://example.com",
        startUrl: "",
        successSelector: "#ok",
        modelName: "models/gemini-3.1-pro-preview",
        registerPassword: "",
        automationToken: "",
        automationClientId: "client-001",
        headless: false,
        midsceneStrict: false,
      }),
    ).toBe(false);
  });

  it("rejects empty baseUrl", () => {
    expect(
      isFirstUseConfigValid({
        baseUrl: "   ",
        startUrl: "",
        successSelector: "#ok",
        modelName: "models/gemini-3.1-pro-preview",
        registerPassword: "",
        automationToken: "",
        automationClientId: "client-001",
        headless: false,
        midsceneStrict: false,
      }),
    ).toBe(false);
  });

  it("rejects invalid startUrl and empty successSelector", () => {
    expect(
      isFirstUseConfigValid({
        baseUrl: "https://example.com",
        startUrl: "not-a-url",
        successSelector: "#ok",
        modelName: "models/gemini-3.1-pro-preview",
        registerPassword: "",
        automationToken: "",
        automationClientId: "client-001",
        headless: false,
        midsceneStrict: false,
      }),
    ).toBe(false);

    expect(
      isFirstUseConfigValid({
        baseUrl: "https://example.com",
        startUrl: "https://example.com/start",
        successSelector: "   ",
        modelName: "models/gemini-3.1-pro-preview",
        registerPassword: "",
        automationToken: "",
        automationClientId: "client-001",
        headless: false,
        midsceneStrict: false,
      }),
    ).toBe(false);
  });
});
