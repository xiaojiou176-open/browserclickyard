import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CONSOLE_TAB_FLOW_DRAFT_TEST_ID,
  CONSOLE_TAB_QUICK_LAUNCH_TEST_ID,
  CONSOLE_TAB_TASK_CENTER_TEST_ID,
} from "../constants/testIds";
import type { AppView } from "../hooks/useAppStore";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";

interface ConsoleHeaderProps {
  runningCount: number;
  successCount: number;
  failedCount: number;
  activeView: AppView;
  locale?: UiLocale;
  onLocaleChange?: (locale: UiLocale) => void;
  onViewChange: (view: AppView) => void;
  onOpenHelp: () => void;
  onRestartTour: () => void;
}

type LaneView = {
  key: AppView;
  label: string;
  desc: string;
  guide: string;
  icon: React.ReactNode;
};

const LANE_MAP_SUMMARY =
  "Start with a target URL in Stress Lab, choose the kind of browser experiment you want to run, inspect the latest result in Runs & Blocks, and open Advanced Review only when you need deeper governed comparison.";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

const laneViews: LaneView[] = [
  {
    key: "launch",
    label: "Stress Lab",
    desc: "Start from a URL",
    guide:
      "Stress Lab is the URL-first entry. Choose the target you want to test, pick a lab mode such as explore, load, perf, chaos, visual, or accessibility, then start the experiment.",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
    ),
  },
  {
    key: "tasks",
    label: "Runs & Blocks",
    desc: "Read the latest result",
    guide:
      "Runs & Blocks is where you read the latest experiment result, spot failures or pauses, and clear manual blockers before you try again.",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  {
    key: "workshop",
    label: "Flow Studio",
    desc: "Refine journeys",
    guide:
      "Flow Studio is the deeper lab area for editing journeys, replaying steps, and tightening exploratory or reusable browser flows after you learn from a run.",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
      </svg>
    ),
  },
  {
    key: "review",
    label: "Advanced Review",
    desc: "Optional proof layer",
    guide:
      "Advanced Review is the optional deep-analysis layer. Use it after you already have a lab result and want governed comparison, proof bundles, AI summaries, or historical matches.",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 3h6" />
        <path d="M12 3v18" />
        <path d="M3 9h18" />
        <path d="M5 19h14" />
      </svg>
    ),
  },
];

const viewTestIds: Record<AppView, string> = {
  launch: CONSOLE_TAB_QUICK_LAUNCH_TEST_ID,
  tasks: CONSOLE_TAB_TASK_CENTER_TEST_ID,
  workshop: CONSOLE_TAB_FLOW_DRAFT_TEST_ID,
  review: "console-tab-review-board",
};

const viewTabIds: Record<AppView, string> = {
  launch: "console-tab-launch",
  tasks: "console-tab-tasks",
  workshop: "console-tab-workshop",
  review: "console-tab-review",
};

const viewPanelIds: Record<AppView, string> = {
  launch: "app-view-launch-panel",
  tasks: "app-view-tasks-panel",
  workshop: "app-view-workshop-panel",
  review: "app-view-review-panel",
};

function ConsoleHeader({
  runningCount,
  successCount,
  failedCount,
  activeView,
  locale = DEFAULT_UI_LOCALE,
  onLocaleChange = () => {},
  onViewChange,
  onOpenHelp,
  onRestartTour,
}: ConsoleHeaderProps) {
  const laneMapSummary = pickUiText(
    locale,
    LANE_MAP_SUMMARY,
    "\u5148\u5728 Stress Lab \u91cc\u586b\u76ee\u6807\u5730\u5740\uff0c\u9009\u62e9\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u518d\u53bb Runs & Blocks \u8bfb\u6700\u65b0\u7ed3\u679c\uff1b\u53ea\u6709\u9700\u8981\u66f4\u6df1\u7684\u6cbb\u7406\u5bf9\u6bd4\u65f6\u624d\u6253\u5f00 Advanced Review\u3002",
  );
  const recommendedFirstPath = pickUiText(
    locale,
    RECOMMENDED_FIRST_PATH,
    "\u63a8\u8350\u8def\u5f84\uff1a\u5148\u586b URL\uff0c\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u542f\u52a8\u5b9e\u9a8c\uff0c\u518d\u8bfb\u7ed3\u679c\uff1b\u6700\u540e\u624d\u8fdb\u5165 Advanced Review\u3002",
  );
  const localizedLaneViews: LaneView[] = useMemo(
    () => [
      {
        ...laneViews[0],
        label: pickUiText(locale, "Stress Lab", "\u538b\u529b\u5b9e\u9a8c\u5ba4"),
        desc: pickUiText(locale, "Start from a URL", "\u4ece URL \u5f00\u59cb"),
        guide: pickUiText(
          locale,
          laneViews[0].guide,
          "Stress Lab \u662f URL-first \u5165\u53e3\u3002\u5148\u9009\u4f60\u8981\u6d4b\u8bd5\u7684\u76ee\u6807\uff0c\u518d\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u6bd4\u5982 explore\u3001load\u3001perf\u3001chaos\u3001visual \u6216 accessibility\uff0c\u7136\u540e\u542f\u52a8\u7b2c\u4e00\u6b21\u5b9e\u9a8c\u3002",
        ),
      },
      {
        ...laneViews[1],
        label: pickUiText(locale, "Runs & Blocks", "\u8fd0\u884c\u4e0e\u963b\u585e"),
        desc: pickUiText(locale, "Read the latest result", "\u5148\u8bfb\u6700\u65b0\u7ed3\u679c"),
        guide: pickUiText(
          locale,
          laneViews[1].guide,
          "Runs & Blocks \u662f\u7ed3\u679c\u53f0\u548c\u963b\u585e\u6536\u4ef6\u7bb1\u3002\u5148\u8bfb\u6700\u65b0\u7ed3\u679c\u3001\u770b\u5931\u8d25\u6216\u6682\u505c\u539f\u56e0\uff0c\u518d\u51b3\u5b9a\u91cd\u8dd1\u8fd8\u662f\u4eba\u5de5\u89e3\u9501\u3002",
        ),
      },
      {
        ...laneViews[2],
        label: pickUiText(locale, "Flow Studio", "\u6d41\u7a0b\u5de5\u4f5c\u5ba4"),
        desc: pickUiText(locale, "Refine journeys", "\u4f18\u5316\u6d41\u7a0b"),
        guide: pickUiText(
          locale,
          laneViews[2].guide,
          "Flow Studio \u662f\u66f4\u6df1\u4e00\u5c42\u7684\u5b9e\u9a8c\u533a\uff0c\u7528\u6765\u8c03\u6574 journey\u3001\u91cd\u653e\u6b65\u9aa4\uff0c\u5e76\u5728\u4f60\u4ece\u4e00\u6b21 run \u5b66\u5230\u4e1c\u897f\u4e4b\u540e\u7ee7\u7eed\u6253\u78e8\u53ef\u590d\u7528\u6d41\u7a0b\u3002",
        ),
      },
      {
        ...laneViews[3],
        label: pickUiText(locale, "Advanced Review", "\u9ad8\u7ea7\u5ba1\u67e5"),
        desc: pickUiText(locale, "Optional proof layer", "\u53ef\u9009\u6df1\u5c42\u8bc1\u660e"),
        guide: pickUiText(
          locale,
          laneViews[3].guide,
          "Advanced Review \u662f\u53ef\u9009\u7684\u6df1\u5ea6\u5206\u6790\u5c42\u3002\u53ea\u6709\u5f53\u4f60\u5df2\u7ecf\u62ff\u5230\u5b9e\u9a8c\u7ed3\u679c\uff0c\u4e14\u9700\u8981\u6cbb\u7406\u5bf9\u6bd4\u3001proof bundle\u3001AI \u6458\u8981\u6216\u5386\u53f2\u76f8\u4f3c\u6848\u4f8b\u65f6\u624d\u6765\u8fd9\u91cc\u3002",
        ),
      },
    ],
    [locale],
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const prevCountsRef = useRef({
    runningCount,
    successCount,
    failedCount,
  });
  const prevActiveViewRef = useRef(activeView);
  const timeoutIdsRef = useRef<number[]>([]);
  const [pulseRunning, setPulseRunning] = useState(false);
  const [pulseSuccess, setPulseSuccess] = useState(false);
  const [pulseFailed, setPulseFailed] = useState(false);
  const [pulseActiveTab, setPulseActiveTab] = useState(false);

  useEffect(() => {
    const timeouts = timeoutIdsRef.current;
    return () => {
      timeouts.forEach((id) => window.clearTimeout(id));
      timeoutIdsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const prev = prevCountsRef.current;
    if (runningCount > prev.runningCount) {
      setPulseRunning(true);
      const id = window.setTimeout(() => setPulseRunning(false), 360);
      timeoutIdsRef.current.push(id);
    }
    if (successCount > prev.successCount) {
      setPulseSuccess(true);
      const id = window.setTimeout(() => setPulseSuccess(false), 420);
      timeoutIdsRef.current.push(id);
    }
    if (failedCount > prev.failedCount) {
      setPulseFailed(true);
      const id = window.setTimeout(() => setPulseFailed(false), 420);
      timeoutIdsRef.current.push(id);
    }
    prevCountsRef.current = {
      runningCount,
      successCount,
      failedCount,
    };
  }, [failedCount, runningCount, successCount]);

  useEffect(() => {
    if (prevActiveViewRef.current === activeView) {
      return;
    }
    prevActiveViewRef.current = activeView;
    setPulseActiveTab(true);
    const id = window.setTimeout(() => setPulseActiveTab(false), 320);
    timeoutIdsRef.current.push(id);
  }, [activeView]);

  const focusTabByIndex = useCallback((targetIndex: number) => {
    const normalizedIndex = ((targetIndex % laneViews.length) + laneViews.length) % laneViews.length;
    tabRefs.current[normalizedIndex]?.focus();
  }, []);

  const activateTabByIndex = useCallback(
    (targetIndex: number) => {
      const normalizedIndex =
        ((targetIndex % laneViews.length) + laneViews.length) % laneViews.length;
      onViewChange(localizedLaneViews[normalizedIndex].key);
    },
    [localizedLaneViews, onViewChange],
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        focusTabByIndex(index + 1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusTabByIndex(index - 1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusTabByIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        focusTabByIndex(laneViews.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateTabByIndex(index);
      }
    },
    [activateTabByIndex, focusTabByIndex],
  );

  return (
    <header>
      <div className="console-header" data-tour="welcome">
        <div className="header-brand">
          <div className="header-logo" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M7 8l4 4-4 4" />
              <line x1="13" y1="16" x2="17" y2="16" />
            </svg>
          </div>
          <div className="header-text">
            <h1>Prooflane</h1>
            <p>{laneMapSummary}</p>
            <p>{recommendedFirstPath}</p>
          </div>
        </div>
        <div className="header-right">
          <div className="header-stats">
            <span
              className={`stat-badge ${runningCount > 0 ? "running" : ""}`}
              data-pulse={pulseRunning ? "true" : undefined}
            >
              <span className="stat-dot" aria-hidden="true" />
              {pickUiText(locale, "Running ", "\u8fd0\u884c\u4e2d ")}
              {runningCount}
            </span>
            <span className="stat-badge success" data-pulse={pulseSuccess ? "true" : undefined}>
              <span className="stat-dot" aria-hidden="true" />
              {pickUiText(locale, "Succeeded ", "\u5df2\u6210\u529f ")}
              {successCount}
            </span>
            <span className="stat-badge failed" data-pulse={pulseFailed ? "true" : undefined}>
              <span className="stat-dot" aria-hidden="true" />
              {pickUiText(locale, "Failed ", "\u5df2\u5931\u8d25 ")}
              {failedCount}
            </span>
          </div>
          <div className="header-stats" role="group" aria-label={pickUiText(locale, "Language", "\u8bed\u8a00")}>
            <button
              type="button"
              className="header-action-btn"
              aria-pressed={locale === "en"}
              onClick={() => onLocaleChange("en")}
              title="Switch to English"
            >
              {"EN"}
            </button>
            <button
              type="button"
              className="header-action-btn"
              aria-pressed={locale === "zh-CN"}
              onClick={() => onLocaleChange("zh-CN")}
              title="\u5207\u6362\u5230\u4e2d\u6587"
            >
              {"\u4e2d\u6587"}
            </button>
          </div>
          <button
            type="button"
            className="header-action-btn"
            onClick={onRestartTour}
            aria-label={pickUiText(locale, "Restart onboarding", "\u91cd\u65b0\u5f00\u59cb\u5f15\u5bfc")}
            title={pickUiText(locale, "Restart onboarding", "\u91cd\u65b0\u5f00\u59cb\u5f15\u5bfc")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0115-6.7L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 01-15 6.7L3 16" />
            </svg>
          </button>
          <button
            type="button"
            className="header-action-btn"
            onClick={onOpenHelp}
            aria-label={pickUiText(locale, "Help", "\u5e2e\u52a9")}
            title={pickUiText(locale, "Help", "\u5e2e\u52a9")}
            data-tour="help-btn"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </button>
        </div>
      </div>
      <nav
        className="nav-tabs"
        aria-label={pickUiText(locale, "Primary navigation", "\u4e3b\u5bfc\u822a")}
        role="tablist"
      >
        {localizedLaneViews.map((v, index) => (
          <button
            key={v.key}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            id={viewTabIds[v.key]}
            className={`nav-tab ${activeView === v.key ? "active" : ""} ${
              activeView === v.key && pulseActiveTab ? "active-pulse" : ""
            }`}
            role="tab"
            aria-selected={activeView === v.key}
            aria-controls={viewPanelIds[v.key]}
            tabIndex={activeView === v.key ? 0 : -1}
            onClick={() => onViewChange(v.key)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            data-tour={`tab-${v.key}`}
            data-testid={viewTestIds[v.key]}
          >
            <span className="nav-tab-icon" aria-hidden="true">
              {v.icon}
            </span>
            {v.label}
            <span className="nav-tab-desc">{v.desc}</span>
          </button>
        ))}
      </nav>
    </header>
  );
}

export default memo(ConsoleHeader);
