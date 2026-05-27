import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const RUM_API_BASE_URL =
  (import.meta.env.VITE_DEFAULT_BASE_URL as string | undefined)?.trim() ?? "";
const RUM_ENABLED =
  ((import.meta.env.VITE_RUM_ENABLED as string | undefined)?.trim().toLowerCase() ?? "false") ===
  "true";
const RUM_FAILURE_COOLDOWN_MS = 60_000;
const RUM_MAX_CONSECUTIVE_FAILURES = 2;

let rumConsecutiveFailures = 0;
let rumDisabledUntilMs = 0;

function buildRumEndpoint(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!RUM_API_BASE_URL) {
    return normalizedPath;
  }
  try {
    return new URL(normalizedPath, RUM_API_BASE_URL).toString();
  } catch {
    return normalizedPath;
  }
}

function rumNavigationType(): string {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return nav?.type ?? "navigate";
}

function emitRumDeliverySignal(status: "ok" | "degraded", detail: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("uiq:rum-delivery", {
      detail: {
        status,
        at: new Date().toISOString(),
        ...detail,
      },
    }),
  );
}

async function sendRumMetric(metric: string, value: number, rating?: string): Promise<void> {
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  if (rumDisabledUntilMs > Date.now()) {
    return;
  }
  try {
    const response = await fetch(buildRumEndpoint("/health/rum"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metric,
        value,
        rating,
        path: window.location.pathname,
        navigationType: rumNavigationType(),
        timestampMs: Date.now(),
      }),
      keepalive: true,
    });
    if (!response.ok) {
      rumConsecutiveFailures += 1;
      emitRumDeliverySignal("degraded", {
        metric,
        reason: "http_error",
        status: response.status,
        consecutiveFailures: rumConsecutiveFailures,
      });
      if (response.status >= 500 || rumConsecutiveFailures >= RUM_MAX_CONSECUTIVE_FAILURES) {
        rumDisabledUntilMs = Date.now() + RUM_FAILURE_COOLDOWN_MS;
      }
      return;
    }
    rumConsecutiveFailures = 0;
    rumDisabledUntilMs = 0;
  } catch {
    rumConsecutiveFailures += 1;
    emitRumDeliverySignal("degraded", {
      metric,
      reason: "network_error",
      consecutiveFailures: rumConsecutiveFailures,
    });
    if (rumConsecutiveFailures >= RUM_MAX_CONSECUTIVE_FAILURES) {
      rumDisabledUntilMs = Date.now() + RUM_FAILURE_COOLDOWN_MS;
    }
  }
}

function setupRumCollection(): void {
  if (!RUM_ENABLED) {
    return;
  }
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
    return;
  }

  const reportMetric = (name: string, value: number) => {
    void sendRumMetric(name, value);
  };

  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (nav) {
    reportMetric("TTFB", Math.max(0, nav.responseStart));
  }

  try {
    const paintObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") {
          reportMetric("FCP", entry.startTime);
        }
      }
    });
    paintObserver.observe({ type: "paint", buffered: true });
  } catch {
    // Browser does not support paint observer.
  }

  let lcpValue = 0;
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        lcpValue = entry.startTime;
      }
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    // Browser does not support LCP observer.
  }

  let clsValue = 0;
  try {
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & { hadRecentInput?: boolean; value?: number }
      >) {
        if (!entry.hadRecentInput) {
          clsValue += entry.value ?? 0;
        }
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
  } catch {
    // Browser does not support CLS observer.
  }

  let inpValue = 0;
  try {
    const inpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & { interactionId?: number; duration?: number }
      >) {
        if ((entry.interactionId ?? 0) > 0 && (entry.duration ?? 0) > inpValue) {
          inpValue = entry.duration ?? 0;
        }
      }
    });
    inpObserver.observe({
      type: "event",
      durationThreshold: 40,
      buffered: true,
    } as PerformanceObserverInit);
  } catch {
    // Browser does not support Event Timing observer.
  }

  const flushFinalVitals = () => {
    if (lcpValue > 0) {
      reportMetric("LCP", lcpValue);
    }
    if (clsValue > 0) {
      reportMetric("CLS", clsValue);
    }
    if (inpValue > 0) {
      reportMetric("INP", inpValue);
    }
  };

  window.addEventListener("pagehide", flushFinalVitals, { once: true });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        flushFinalVitals();
      }
    },
    { once: true },
  );
}

function scheduleRumCollection(): void {
  if (!RUM_ENABLED) {
    return;
  }
  const kickoff = () => {
    const requestIdleCallbackFn = (
      window as Window & {
        requestIdleCallback?: (callback: IdleRequestCallback) => number;
      }
    ).requestIdleCallback;
    if (typeof requestIdleCallbackFn === "function") {
      requestIdleCallbackFn(() => {
        setupRumCollection();
      });
      return;
    }
    globalThis.setTimeout(() => {
      setupRumCollection();
    }, 0);
  };
  if (typeof document !== "undefined" && document.readyState === "complete") {
    kickoff();
    return;
  }
  window.addEventListener("load", kickoff, { once: true });
}

scheduleRumCollection();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
