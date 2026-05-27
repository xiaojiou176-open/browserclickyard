/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_LOCALE_STORAGE_KEY } from "../i18n/uiLocale";
import { resolveAutomationClientId, resolveDefaultBaseUrl, useAppStore } from "./useAppStore";

describe("useAppStore runtime defaults", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    document.documentElement.removeAttribute("data-uiq-visual");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    localStorage.clear();
    document.documentElement.removeAttribute("data-uiq-visual");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("falls back to current origin when VITE_DEFAULT_BASE_URL is not provided", () => {
    expect(resolveDefaultBaseUrl(undefined, "http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
  });

  it("uses deterministic automationClientId in visual snapshot mode", () => {
    document.documentElement.setAttribute("data-uiq-visual", "1");
    let clientId = "";

    function Harness() {
      const store = useAppStore();
      clientId = store.params.automationClientId;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    expect(clientId).toBe("client-visual-ci");
    expect(localStorage.getItem("ab_automation_client_id")).toBe("client-visual-ci");
  });

  it("keeps existing client id when deterministic mode is disabled", () => {
    expect(resolveAutomationClientId("client-existing", false)).toBe("client-existing");
  });

  it("keeps automation token empty even when VITE_AUTOMATION_TOKEN is set", () => {
    const env = import.meta.env as Record<string, unknown>;
    const previousEnvToken = env.VITE_AUTOMATION_TOKEN;
    env.VITE_AUTOMATION_TOKEN = "env-default-token";
    let automationToken = "";

    function Harness() {
      const store = useAppStore();
      automationToken = store.params.automationToken;
      return null;
    }

    try {
      act(() => {
        root.render(<Harness />);
      });
      expect(automationToken).toBe("");
    } finally {
      env.VITE_AUTOMATION_TOKEN = previousEnvToken;
    }
  });

  it("persists the selected UI locale", () => {
    let switchLocale: ((locale: "en" | "zh-CN") => void) | null = null;

    function Harness() {
      const store = useAppStore();
      switchLocale = store.setUiLocale;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    act(() => {
      switchLocale?.("zh-CN");
    });

    expect(localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });
});
