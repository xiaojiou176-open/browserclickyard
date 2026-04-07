/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAutomationClientId, useAppStore } from "./useAppStore";

describe("useAppStore coverage expansion", () => {
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
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("resolves automation client id with generated and fallback values", () => {
    const randomUuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");
    randomUuidSpy.mockReturnValue("123e4567-e89b-12d3-a456-426614174000");
    expect(resolveAutomationClientId(undefined, false)).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );

    randomUuidSpy.mockImplementation(() => {
      throw new Error("no uuid");
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(123);
    expect(resolveAutomationClientId(undefined, false)).toBe("client-123");
    expect(resolveAutomationClientId("stored-1", false)).toBe("stored-1");
    expect(resolveAutomationClientId("stored-1", true)).toBe("client-visual-ci");
    nowSpy.mockRestore();
  });

  it("keeps deterministic client id in test runtime and handles malformed first-use cache", () => {
    localStorage.setItem("ab_first_use_stage", "verify");
    localStorage.setItem("ab_first_use_progress", "{bad-json");

    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();
    expect(currentStore()?.params.automationClientId).toBe("client-visual-ci");
    expect(localStorage.getItem("ab_automation_client_id")).toBe("client-visual-ci");
    expect(currentStore()?.firstUseStage).toBe("run");

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    act(() => {
      currentStore()?.setParams((prev) => ({ ...prev, automationClientId: "new-client-id" }));
    });
    expect(currentStore()?.params.automationClientId).toBe("new-client-id");
    setItemSpy.mockRestore();
  });

  it("supports onboarding helpers, log trimming, and notice lifecycle", () => {
    vi.useFakeTimers();
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();

    act(() => {
      currentStore()?.completeOnboarding();
    });
    expect(localStorage.getItem("ab_onboarding_done")).toBe("1");

    act(() => {
      currentStore()?.restartOnboarding();
    });
    expect(localStorage.getItem("ab_onboarding_done")).toBeNull();

    act(() => {
      for (let i = 0; i < 505; i += 1) {
        currentStore()?.addLog("info", `log-${i}`);
      }
    });
    expect(currentStore()?.logs.length).toBe(500);
    expect(currentStore()?.logs[0]?.message).toBe("log-5");

    act(() => {
      currentStore()?.pushNotice("warn", "toast-1");
      currentStore()?.pushNotice("error", "toast-2");
    });
    expect(currentStore()?.notices.length).toBe(2);

    const firstNoticeId = currentStore()?.notices[0]?.id ?? "";
    expect(firstNoticeId).not.toBe("");
    act(() => {
      currentStore()?.dismissNotice(firstNoticeId);
    });
    expect(currentStore()?.notices.length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(4200);
    });
    expect(currentStore()?.notices.length).toBe(0);

    vi.useRealTimers();
  });

  it("drives first-use stage transitions to completion", async () => {
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();

    act(() => {
      currentStore()?.handleParamsChange({ baseUrl: "invalid-url" });
    });
    act(() => {
      currentStore()?.setFirstUseStage("verify");
      currentStore()?.completeFirstUse();
    });
    expect(currentStore()?.firstUseStage).toBe("configure");

    act(() => {
      currentStore()?.handleParamsChange({ baseUrl: "https://example.com" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      currentStore()?.setFirstUseStage("verify");
      currentStore()?.completeFirstUse();
    });
    expect(currentStore()?.firstUseStage).toBe("run");

    act(() => {
      currentStore()?.markFirstUseRunTriggered();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore()?.firstUseStage).toBe("verify");

    act(() => {
      currentStore()?.markFirstUseResultSeen();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      currentStore()?.completeFirstUse();
    });
    expect(currentStore()?.isFirstUseActive).toBe(false);
    expect(localStorage.getItem("ab_first_use_done")).toBe("1");

    act(() => {
      currentStore()?.clearLogs();
    });
    expect(currentStore()?.logs).toEqual([]);
  });

  it("covers first-use guard branches when flow is inactive or partially complete", async () => {
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();

    act(() => {
      currentStore()?.setIsFirstUseActive(false);
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      currentStore()?.markFirstUseRunTriggered();
      currentStore()?.markFirstUseResultSeen();
    });
    expect(currentStore()?.firstUseProgress.runTriggered).toBe(false);
    expect(currentStore()?.firstUseProgress.resultSeen).toBe(false);

    act(() => {
      currentStore()?.setIsFirstUseActive(true);
      currentStore()?.handleParamsChange({
        baseUrl: "https://example.com",
        successSelector: "#ok",
      });
      currentStore()?.markFirstUseRunTriggered();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      currentStore()?.completeFirstUse();
    });
    expect(["run", "verify"]).toContain(currentStore()?.firstUseStage);
    expect(currentStore()?.isFirstUseActive).toBe(true);
  });

  it("handles localStorage failures in onboarding and completion writes", async () => {
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });
    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    act(() => {
      currentStore()?.completeOnboarding();
      currentStore()?.restartOnboarding();
      currentStore()?.handleParamsChange({
        baseUrl: "https://example.com",
        successSelector: "#ok",
      });
      currentStore()?.markFirstUseRunTriggered();
      currentStore()?.markFirstUseResultSeen();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      currentStore()?.completeFirstUse();
    });
    expect(currentStore()?.isFirstUseActive).toBe(false);

    setItemSpy.mockRestore();
    removeItemSpy.mockRestore();
  });

  it("covers storage-read fallbacks", async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });
    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();
    expect(currentStore()?.isFirstUseActive).toBe(true);
    expect(currentStore()?.showOnboarding).toBe(true);

    getItemSpy.mockRestore();
  });

  it("forces stage clamping effect and progress-persistence catch path", async () => {
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });
    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();

    act(() => {
      currentStore()?.handleParamsChange({
        baseUrl: "https://example.com",
        successSelector: "#ok",
      });
      currentStore()?.setFirstUseStage("run");
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      currentStore()?.handleParamsChange({ baseUrl: "not-a-url" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore()?.firstUseStage).toBe("configure");

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("persist blocked");
    });
    act(() => {
      currentStore()?.setFirstUseStage("configure");
    });
    await act(async () => {
      await Promise.resolve();
    });
    setItemSpy.mockRestore();
  });

  it("handles invalid stored stage fallback and empty automation client id branch", () => {
    localStorage.setItem("ab_first_use_stage", "bad-stage");
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });
    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();
    expect(currentStore()?.firstUseStage).toBe("welcome");

    act(() => {
      currentStore()?.setParams((prev) => ({ ...prev, automationClientId: "" }));
    });
    expect(currentStore()?.params.automationClientId).toBe("");
  });

  it("persists otp input per selected run and auto-completes first-use outcome in tasks view", async () => {
    let storeRef: ReturnType<typeof useAppStore> | null = null;
    function Harness() {
      const store = useAppStore();
      storeRef = store;
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });
    const currentStore = () => storeRef;
    expect(currentStore()).not.toBeNull();

    act(() => {
      currentStore()?.setSelectedStudioRunId("run-a");
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      currentStore()?.setStudioOtpCode("111111");
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      currentStore()?.setSelectedStudioRunId("run-b");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore()?.studioOtpCode).toBe("");

    act(() => {
      currentStore()?.setSelectedStudioRunId("run-a");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore()?.studioOtpCode).toBe("111111");

    act(() => {
      currentStore()?.setActiveView("tasks");
      currentStore()?.setSelectedTaskId("task-1");
      currentStore()?.setTasks([
        {
          task_id: "task-1",
          command_id: "cmd-1",
          status: "success",
          requested_by: null,
          attempt: 1,
          max_attempts: 1,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          exit_code: 0,
          message: null,
          output_tail: "",
        },
      ]);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentStore()?.firstUseProgress.resultSeen).toBe(true);
    expect(currentStore()?.firstUseStage).toBe("verify");
  });
});
