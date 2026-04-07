import { useEffect, useRef } from "react";
import type { FetchTaskOptions } from "../types";
import type { AppStore } from "./useAppStore";

const POLL_ACTIVE_MS = 2_000;
const POLL_HIDDEN_MS = 15_000;
const BACKOFF_MAX_MS = 30_000;

export function usePolling(
  store: AppStore,
  bootstrap: () => Promise<void>,
  fetchTasks: (opts?: FetchTaskOptions) => Promise<void>,
) {
  const bootstrapStartedRef = useRef(false);
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;
  const fetchTasksRef = useRef(fetchTasks);
  fetchTasksRef.current = fetchTasks;
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    if (bootstrapStartedRef.current) {
      return;
    }
    bootstrapStartedRef.current = true;
    void bootstrapRef.current();

    let timer = 0;
    let disposed = false;
    let consecutiveErrors = 0;

    const handlePollError = (error: unknown) => {
      consecutiveErrors += 1;
      const message = error instanceof Error ? error.message : "Automatic task refresh failed";
      storeRef.current.setTaskSyncError(message);
      storeRef.current.addLog("warn", message);
      // Only show notice on first failure, not every retry
      if (consecutiveErrors === 1) {
        storeRef.current.pushNotice("warn", message);
      }
    };

    const getInterval = () => {
      const base = document.hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS;
      if (consecutiveErrors === 0) {
        return base;
      }
      // Exponential backoff: 2s -> 4s -> 8s -> ... capped at 30s
      return Math.min(base * 2 ** consecutiveErrors, BACKOFF_MAX_MS);
    };

    const schedulePoll = () => {
      if (disposed) {
        return;
      }
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(async () => {
        if (disposed) {
          return;
        }
        try {
          await fetchTasksRef.current({ background: true });
          consecutiveErrors = 0;
        } catch (error: unknown) {
          handlePollError(error);
        }
        if (!disposed) {
          schedulePoll();
        }
      }, getInterval());
    };

    schedulePoll();

    const onVisibilityChange = () => {
      if (!document.hidden) {
        // Tab became visible: fetch immediately and reset schedule
        void fetchTasksRef
          .current({ background: true })
          .then(() => {
            consecutiveErrors = 0;
          })
          .catch(handlePollError);
      }
      // Re-schedule with the new interval (active vs hidden)
      schedulePoll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      if (timer) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Clear sensitive data on unload
  useEffect(() => {
    const clearSensitive = () =>
      storeRef.current.setParams((p) => ({ ...p, registerPassword: "" }));
    window.addEventListener("beforeunload", clearSensitive);
    return () => window.removeEventListener("beforeunload", clearSensitive);
  }, []);
}
