/* @vitest-environment jsdom */

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchTaskOptions } from "../types";
import type { AppStore } from "./useAppStore";
import { usePolling } from "./usePolling";

type StoreStub = {
  setCommandState: ReturnType<typeof vi.fn>;
  setTaskState: ReturnType<typeof vi.fn>;
  setFeedbackText: ReturnType<typeof vi.fn>;
  setTaskSyncError: ReturnType<typeof vi.fn>;
  addLog: ReturnType<typeof vi.fn>;
  pushNotice: ReturnType<typeof vi.fn>;
  setParams: ReturnType<typeof vi.fn>;
};

function createStore(): AppStore & StoreStub {
  const store: StoreStub = {
    setCommandState: vi.fn(),
    setTaskState: vi.fn(),
    setFeedbackText: vi.fn(),
    setTaskSyncError: vi.fn(),
    addLog: vi.fn(),
    pushNotice: vi.fn(),
    setParams: vi.fn(),
  };
  return store as unknown as AppStore & StoreStub;
}

function PollingHarness({
  store,
  bootstrap,
  fetchTasks,
}: {
  store: AppStore;
  bootstrap: () => Promise<void>;
  fetchTasks: (opts?: FetchTaskOptions) => Promise<void>;
}) {
  usePolling(store, bootstrap, fetchTasks);
  return null;
}

describe("usePolling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    // Let React know this environment supports act().
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("keeps polling after rerender with a new store reference", async () => {
    const firstStore = createStore();
    const secondStore = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        <PollingHarness store={firstStore} bootstrap={bootstrap} fetchTasks={fetchTasks} />,
      );
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(fetchTasks).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <PollingHarness store={secondStore} bootstrap={bootstrap} fetchTasks={fetchTasks} />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });

    expect(fetchTasks).toHaveBeenCalledTimes(2);
  });

  it("guards bootstrap during StrictMode double-effect execution", () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        <StrictMode>
          <PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />
        </StrictMode>,
      );
    });

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("does not reschedule polling after unmount while a fetch is in flight", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    let resolveFetch: ((value?: void | PromiseLike<void>) => void) | undefined;
    const fetchTasks = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(fetchTasks).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    resolveFetch?.();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(fetchTasks).toHaveBeenCalledTimes(1);
  });

  it("applies the same error path for visibility-triggered refresh failures", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const visibilityError = new Error("visibility refresh failed");
    const fetchTasks = vi.fn().mockRejectedValueOnce(visibilityError);
    const timeoutSpy = vi.spyOn(window, "setTimeout");

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_000);

    await act(async () => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(fetchTasks).toHaveBeenCalledTimes(1);
    expect(store.setTaskSyncError).toHaveBeenCalledWith("visibility refresh failed");
    expect(store.pushNotice).toHaveBeenCalledWith("warn", "visibility refresh failed");
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
  });

  it("uses exponential backoff after polling failures", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockRejectedValue(new Error("poll failed"));
    const timeoutSpy = vi.spyOn(window, "setTimeout");

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(fetchTasks).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 4_000);

    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });
    expect(fetchTasks).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 8_000);
    expect(store.pushNotice).toHaveBeenCalledTimes(1);
  });

  it("returns early when visibility-change re-schedule runs after disposal", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });

    act(() => {
      root.unmount();
    });

    await act(async () => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(fetchTasks).toHaveBeenCalledTimes(0);
  });

  it("executes disposed schedule guard when visibility handler is invoked after cleanup", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockResolvedValue(undefined);
    let visibilityHandler: (() => void) | undefined;
    const addListenerSpy = vi.spyOn(document, "addEventListener");
    addListenerSpy.mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type === "visibilitychange" && typeof listener === "function") {
        visibilityHandler = listener as () => void;
      }
    }) as typeof document.addEventListener);

    const timeoutSpy = vi.spyOn(window, "setTimeout");

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });
    const before = timeoutSpy.mock.calls.length;

    act(() => {
      root.unmount();
    });
    await act(async () => {
      visibilityHandler?.();
      await Promise.resolve();
    });

    expect(timeoutSpy.mock.calls.length).toBe(before);
    addListenerSpy.mockRestore();
  });

  it("returns early inside timer callback when disposed before timeout fires", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });

    act(() => {
      root.unmount();
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });

    expect(fetchTasks).toHaveBeenCalledTimes(0);
  });

  it("executes disposed timer guard when a queued timer callback runs after cleanup", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockResolvedValue(undefined);
    let scheduled: (() => Promise<void>) | undefined;
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    timeoutSpy.mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") {
        scheduled = handler as () => Promise<void>;
      }
      return 1;
    }) as typeof window.setTimeout);

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });

    act(() => {
      root.unmount();
    });
    await act(async () => {
      await scheduled?.();
      await Promise.resolve();
    });

    expect(fetchTasks).toHaveBeenCalledTimes(0);
  });

  it("resets error backoff after visibility refresh succeeds", async () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi
      .fn()
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockResolvedValue(undefined);
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    Object.defineProperty(document, "hidden", { value: false, configurable: true });

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 4_000);

    await act(async () => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 4_000);

    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
  });

  it("clears registerPassword on beforeunload", () => {
    const store = createStore();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const fetchTasks = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(<PollingHarness store={store} bootstrap={bootstrap} fetchTasks={fetchTasks} />);
    });

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    expect(store.setParams).toHaveBeenCalledTimes(1);
    const [updater] = store.setParams.mock.calls[0] as [
      (prev: { registerPassword: string; untouched: string }) => unknown,
    ];
    expect(updater({ registerPassword: "secret", untouched: "x" })).toEqual({
      registerPassword: "",
      untouched: "x",
    });
  });
});
