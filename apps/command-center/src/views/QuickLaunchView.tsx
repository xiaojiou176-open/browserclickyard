import { memo, useCallback, useEffect, useState } from "react";
import CommandGrid from "../components/CommandGrid";
import EmptyState from "../components/EmptyState";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import type { ParamsState } from "../components/ParamsPanel";
import ParamsPanel from "../components/ParamsPanel";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "../components/ui";
import type { FirstUseStage } from "../hooks/useAppStore";
import { useProofApi } from "../hooks/useProofApi";
import type {
  Command,
  CommandCategory,
  CommandState,
  TargetFeasibility,
  UniversalTemplate,
} from "../types";

const LANE_MAP_SUMMARY =
  "Start with a target URL in Stress Lab, choose the kind of browser experiment you want to run, inspect the latest result in Runs & Blocks, and open Advanced Review only when you need deeper governed comparison.";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

type LabMode = {
  title: string;
  description: string;
  bestWhen: string;
  badge: string;
};

const LAB_MODES: readonly LabMode[] = [
  {
    title: "Explore",
    description: "Crawl states, discover paths, and surface fragile interactions before you script or reuse them.",
    bestWhen: "Best when you are meeting a new WebUI or trying to understand how many states it can reach.",
    badge: "Path discovery",
  },
  {
    title: "Load",
    description: "Push traffic, watch latency and failed requests, and see how the UI behaves under pressure.",
    bestWhen: "Best when you want throughput, p95/p99, timeout, or failure-hotspot signals.",
    badge: "Stress",
  },
  {
    title: "Perf",
    description: "Measure Web Vitals and browser-side performance on a real page, not just a synthetic number in isolation.",
    bestWhen: "Best when you care about LCP, FCP, and loading experience for the current page.",
    badge: "Performance",
  },
  {
    title: "Chaos",
    description: "Throw noisy interaction patterns at the UI to expose brittle flows, stuck states, and unstable paths.",
    bestWhen: "Best when the page works on the happy path but feels fragile under real user behaviour.",
    badge: "Resilience",
  },
  {
    title: "Visual",
    description: "Compare screenshots and layout changes so visual regressions do not hide inside otherwise passing runs.",
    bestWhen: "Best when layout, rendering, or visual drift matters as much as logic.",
    badge: "Regression",
  },
  {
    title: "A11y",
    description: "Scan for serious accessibility issues and treat them as part of the lab result, not an afterthought.",
    bestWhen: "Best when you need WCAG-focused signals alongside other browser evidence.",
    badge: "Accessibility",
  },
] as const;

function localizeLabMode(locale: UiLocale, mode: LabMode): LabMode {
  if (locale === "en") {
    return mode;
  }

  const translations: Record<string, LabMode> = {
    Explore: {
      title: "探索",
      description: "遍历状态、发现路径，并在真正编写或复用流程之前先暴露脆弱交互。",
      bestWhen: "适合第一次接触一个新 WebUI，或想先看它到底能走到多少状态。",
      badge: "路径发现",
    },
    Load: {
      title: "负载",
      description: "持续施压、观察延迟与失败请求，并查看 UI 在压力下的真实表现。",
      bestWhen: "适合关注吞吐、p95/p99、超时或失败热点。",
      badge: "压力",
    },
    Perf: {
      title: "性能",
      description: "在真实页面上测 Web Vitals 和浏览器侧性能，而不是只看孤立数字。",
      bestWhen: "适合关注 LCP、FCP 和当前页面加载体验。",
      badge: "性能",
    },
    Chaos: {
      title: "混沌",
      description: "向 UI 投入更嘈杂的交互模式，主动暴露脆弱流程、卡死状态和不稳定路径。",
      bestWhen: "适合页面在 happy path 正常，但在真实用户行为下显得脆弱。",
      badge: "韧性",
    },
    Visual: {
      title: "视觉",
      description: "对比截图和布局变化，避免视觉回归藏在其他通过项后面。",
      bestWhen: "适合布局、渲染或视觉漂移和逻辑同样重要的时候。",
      badge: "回归",
    },
    A11y: {
      title: "无障碍",
      description: "扫描严重无障碍问题，让它们成为实验结果的一部分，而不是事后补查。",
      bestWhen: "适合想把 WCAG 信号和其他浏览器证据一起看时。",
      badge: "可访问",
    },
  };

  return translations[mode.title] ?? mode;
}

interface QuickLaunchViewProps {
  commands: Command[];
  commandState: CommandState;
  activeTab: "all" | CommandCategory;
  submittingId: string;
  feedbackText: string;
  onActiveTabChange: (tab: "all" | CommandCategory) => void;
  onRunCommand: (command: Command) => void;
  params: ParamsState;
  onParamsChange: (patch: Partial<ParamsState>) => void;
  // Studio template integration
  templates: UniversalTemplate[];
  templateHistory: UniversalTemplate[];
  onCreateRun: () => void | Promise<unknown>;
  onForkTemplateVersion: () => void | Promise<unknown>;
  onMarkTemplateRecommended: () => void | Promise<unknown>;
  onRunParamsChange: (params: Record<string, string>) => void;
  runParams: Record<string, string>;
  onSelectedTemplateIdChange: (id: string) => void;
  selectedTemplateId: string;
  locale?: UiLocale;
  isFirstUseActive: boolean;
  firstUseStage: FirstUseStage;
  firstUseProgress: {
    configValid: boolean;
    runTriggered: boolean;
    resultSeen: boolean;
  };
  canCompleteFirstUse: boolean;
  onFirstUseStageChange: (stage: FirstUseStage) => void;
  onCompleteFirstUse: () => void;
  onGoToTasks?: () => void;
}

function QuickLaunchView({
  commands,
  commandState,
  activeTab,
  submittingId,
  feedbackText,
  onActiveTabChange,
  onRunCommand,
  params,
  onParamsChange,
  templates,
  templateHistory,
  onCreateRun,
  onForkTemplateVersion,
  onMarkTemplateRecommended,
  onRunParamsChange,
  runParams,
  onSelectedTemplateIdChange,
  selectedTemplateId,
  locale = DEFAULT_UI_LOCALE,
  isFirstUseActive,
  firstUseStage,
  firstUseProgress,
  canCompleteFirstUse,
  onFirstUseStageChange,
  onCompleteFirstUse,
  onGoToTasks = () => {},
}: QuickLaunchViewProps) {
  const laneMapSummary = pickUiText(
    locale,
    LANE_MAP_SUMMARY,
    "\u5148\u5728 Stress Lab \u586b\u76ee\u6807 URL\u3001\u9009\u62e9\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u518d\u53bb Runs & Blocks \u8bfb\u7ed3\u679c\uff1b\u53ea\u6709\u9700\u8981\u66f4\u6df1\u6cbb\u7406\u5bf9\u6bd4\u65f6\u624d\u6253\u5f00 Advanced Review\u3002",
  );
  const recommendedFirstPath = pickUiText(
    locale,
    RECOMMENDED_FIRST_PATH,
    "\u63a8\u8350\u8def\u5f84\uff1a\u5148\u586b URL\uff0c\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u542f\u52a8\u5b9e\u9a8c\uff0c\u518d\u8bfb\u7ed3\u679c\uff1b\u6700\u540e\u624d\u8fdb\u5165 Advanced Review\u3002",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [isCreatingRun, setIsCreatingRun] = useState(false);
  const [feasibilityTarget, setFeasibilityTarget] = useState("web.local");
  const [templateFeasibility, setTemplateFeasibility] = useState<TargetFeasibility | null>(null);
  const [feasibilityError, setFeasibilityError] = useState("");
  const [isCheckingFeasibility, setIsCheckingFeasibility] = useState(false);
  const proofApi = useProofApi(
    params.baseUrl,
    params.automationToken,
    params.automationClientId,
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 1024px)");
    const syncLayout = () => setIsCompactLayout(mediaQuery.matches);
    syncLayout();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncLayout);
      return () => mediaQuery.removeEventListener("change", syncLayout);
    }
    const legacyMediaQuery = mediaQuery as MediaQueryList & {
      addListener?: (listener: (this: MediaQueryList, event: MediaQueryListEvent) => void) => void;
      removeListener?: (
        listener: (this: MediaQueryList, event: MediaQueryListEvent) => void,
      ) => void;
    };
    legacyMediaQuery.addListener?.(syncLayout);
    return () => legacyMediaQuery.removeListener?.(syncLayout);
  }, []);

  const canToggleSidebar = !isCompactLayout;
  const showSidebarPanel = isCompactLayout || !sidebarCollapsed;
  const isCurrentStage = (stage: FirstUseStage) => firstUseStage === stage;
  const canGoConfigure = isCurrentStage("welcome") || isCurrentStage("configure");
  const canGoRun =
    (isCurrentStage("configure") || isCurrentStage("run")) && firstUseProgress.configValid;
  const canShowComplete = firstUseStage === "verify";
  const firstUseStateTitle = !firstUseProgress.configValid
    ? pickUiText(locale, "State: no config yet", "\u72b6\u6001\uff1a\u8fd8\u6ca1\u6709\u914d\u7f6e")
    : !firstUseProgress.runTriggered
      ? pickUiText(
          locale,
          "State: config ready, run not started",
          "\u72b6\u6001\uff1a\u914d\u7f6e\u5df2\u5c31\u7eea\uff0c\u8fd8\u672a\u542f\u52a8",
        )
      : firstUseProgress.resultSeen
        ? pickUiText(
            locale,
            "State: result is ready to read",
            "\u72b6\u6001\uff1a\u7ed3\u679c\u5df2\u51c6\u5907\u597d",
          )
        : pickUiText(
            locale,
            "State: run is queued or still landing",
            "\u72b6\u6001\uff1a\u8fd0\u884c\u5df2\u542f\u52a8\uff0c\u6b63\u5728\u843d\u5730",
          );
  const firstUseStateHint = !firstUseProgress.configValid
    ? pickUiText(
        locale,
        "Fill in the target first. The parameter panel is the real step one for a first run.",
        "\u5148\u628a\u76ee\u6807\u586b\u597d\u3002\u53c2\u6570\u9762\u677f\u624d\u662f\u7b2c\u4e00\u6b65\u7684\u771f\u6b63\u8d77\u70b9\u3002",
      )
    : !firstUseProgress.runTriggered
      ? pickUiText(
          locale,
          "You are ready to choose one lab mode and launch a single experiment.",
          "\u4f60\u73b0\u5728\u53ef\u4ee5\u9009\u4e00\u4e2a\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u7136\u540e\u542f\u52a8\u7b2c\u4e00\u6b21\u5b9e\u9a8c\u3002",
        )
      : firstUseProgress.resultSeen
        ? pickUiText(
            locale,
            "Move to Runs & Blocks now. That is where this first slice wants the user to read the verdict before going deeper.",
            "\u73b0\u5728\u8bf7\u8f6c\u5230 Runs & Blocks\u3002\u8fd9\u4e2a\u9996\u5200\u7684\u76ee\u6807\uff0c\u5c31\u662f\u5148\u8ba9\u4eba\u5728\u90a3\u91cc\u8bfb\u7ed3\u8bba\uff0c\u518d\u5f80\u66f4\u6df1\u7684\u5c42\u8d70\u3002",
          )
        : pickUiText(
            locale,
            "Stay on the launch path until the run settles. If it pauses for OTP or manual input, continue in Runs & Blocks instead of jumping to deeper lanes.",
            "\u8bf7\u7ee7\u7eed\u5f85\u5728\u542f\u52a8\u4e3b\u7ebf\u4e0a\uff0c\u76f4\u5230\u8fd0\u884c\u843d\u7a33\u3002\u5982\u679c\u5b83\u5361\u5728 OTP \u6216\u4eba\u5de5\u8f93\u5165\uff0c\u5c31\u53bb Runs & Blocks \u7ee7\u7eed\uff0c\u4e0d\u8981\u5148\u8df3\u8fdb\u66f4\u6df1\u7684 lane\u3002",
          );
  const launchChecklist = [
    {
      title: pickUiText(locale, "1. Configure the target", "1. \u914d\u7f6e\u76ee\u6807"),
      body: pickUiText(
        locale,
        "Use the parameter panel to set the base URL, optional start URL, and success checkpoint.",
        "\u5728\u53c2\u6570\u9762\u677f\u91cc\u8bbe\u7f6e base URL\u3001\u53ef\u9009 start URL \u548c success checkpoint\u3002",
      ),
      status: firstUseProgress.configValid
        ? pickUiText(locale, "Ready", "\u5df2\u5c31\u7eea")
        : pickUiText(locale, "Required", "\u5fc5\u586b"),
      badgeVariant: firstUseProgress.configValid ? "default" : "secondary",
    },
    {
      title: pickUiText(locale, "2. Choose one lab mode", "2. \u9009\u4e00\u4e2a\u5b9e\u9a8c\u6a21\u5f0f"),
      body: pickUiText(
        locale,
        "Pick the single question you want answered first: explore, load, perf, chaos, visual, or accessibility.",
        "\u5148\u9009\u8fd9\u4e00\u8f6e\u6700\u60f3\u56de\u7b54\u7684\u95ee\u9898\uff1a\u63a2\u7d22\u3001\u8d1f\u8f7d\u3001\u6027\u80fd\u3001\u6df7\u6c8c\u3001\u89c6\u89c9\u6216\u65e0\u969c\u788d\u3002",
      ),
      status: firstUseProgress.configValid
        ? pickUiText(locale, "Choose now", "\u73b0\u5728\u9009")
        : pickUiText(locale, "After config", "\u914d\u7f6e\u540e"),
      badgeVariant: firstUseProgress.configValid ? "default" : "secondary",
    },
    {
      title: pickUiText(locale, "3. Run, then read Runs & Blocks", "3. \u542f\u52a8\uff0c\u7136\u540e\u8bfb Runs & Blocks"),
      body: pickUiText(
        locale,
        "Launch from the command grid or a reusable template, then move to Runs & Blocks to read the verdict or clear manual gates.",
        "\u4ece command grid \u6216\u53ef\u590d\u7528\u6a21\u677f\u53d1\u8d77\u8fd0\u884c\uff0c\u7136\u540e\u53bb Runs & Blocks \u8bfb\u7ed3\u8bba\u6216\u6e05\u6389\u4eba\u5de5\u95f8\u95e8\u3002",
      ),
      status: firstUseProgress.resultSeen
        ? pickUiText(locale, "Result ready", "\u7ed3\u679c\u5df2\u5c31\u7eea")
        : firstUseProgress.runTriggered
          ? pickUiText(locale, "In progress", "\u8fdb\u884c\u4e2d")
          : pickUiText(locale, "Next", "\u4e0b\u4e00\u6b65"),
      badgeVariant:
        firstUseProgress.runTriggered || firstUseProgress.resultSeen ? "default" : "secondary",
    },
  ] as const;
  const selectedTemplate = templates.find((tpl) => tpl.template_id === selectedTemplateId) ?? null;
  const missingRequiredTemplateParams = selectedTemplate
    ? selectedTemplate.params_schema
        .filter((param) => param.required)
        .filter((param) => !(runParams[param.key] ?? "").trim())
        .map((param) => param.description || param.key)
    : [];
  const canCreateRun = missingRequiredTemplateParams.length === 0;
  const handleCreateRunClick = useCallback(async () => {
    const maybePromise = onCreateRun();
    if (!maybePromise || typeof (maybePromise as Promise<unknown>).then !== "function") {
      return;
    }
    setIsCreatingRun(true);
    try {
      await maybePromise;
    } finally {
      setIsCreatingRun(false);
    }
  }, [onCreateRun]);

  useEffect(() => {
    setTemplateFeasibility(null);
    setFeasibilityError("");
  }, [selectedTemplateId, feasibilityTarget]);

  const handleCheckFeasibility = useCallback(async () => {
    if (!selectedTemplateId.trim()) {
      return;
    }
    setIsCheckingFeasibility(true);
    setFeasibilityError("");
    try {
      const nextFeasibility = await proofApi.getTemplateFeasibility(
        selectedTemplateId,
        feasibilityTarget,
      );
      setTemplateFeasibility(nextFeasibility);
    } catch (error) {
      setFeasibilityError(
        error instanceof Error
          ? error.message
          : pickUiText(locale, "Loading target fit details failed.", "加载目标适配详情失败。"),
      );
    } finally {
      setIsCheckingFeasibility(false);
    }
  }, [feasibilityTarget, locale, proofApi, selectedTemplateId]);

  return (
    <div
      className="quick-launch-view"
      id="app-view-launch-panel"
      role="tabpanel"
      aria-labelledby="console-tab-launch"
    >
      <div className="quick-launch-main">
        {isFirstUseActive && (
          <Card className="mb-4">
            <div className="section-divider">
              <span className="section-divider-line" />
              <span className="section-divider-label">
                {pickUiText(locale, "First-run guide", "\u9996\u6b21\u5f15\u5bfc")}
              </span>
              <span className="section-divider-line" />
            </div>
            <CardContent className="p-4">
              <p className="text-muted">{laneMapSummary}</p>
              <p className="text-muted">{recommendedFirstPath}</p>
              <p className="text-muted">
                {firstUseStage === "welcome" &&
                  pickUiText(
                    locale,
                    "Welcome. Start by entering the WebUI target and choosing the kind of experiment you want to run.",
                    "\u6b22\u8fce\u4f7f\u7528\u3002\u5148\u586b\u5199\u4f60\u8981\u6d4b\u8bd5\u7684 WebUI \u76ee\u6807\uff0c\u518d\u9009\u62e9\u8fd9\u6b21\u5b9e\u9a8c\u60f3\u56de\u7b54\u7684\u95ee\u9898\u7c7b\u578b\u3002",
                  )}
                {firstUseStage === "configure" &&
                  pickUiText(
                    locale,
                    "Step 1: Configure the target URL, optional start page, and success checkpoint so the lab knows what page to test.",
                    "\u6b65\u9aa4 1\uff1a\u914d\u7f6e\u76ee\u6807 URL\u3001\u53ef\u9009\u8d77\u59cb\u9875\u548c\u6210\u529f\u68c0\u67e5\u70b9\uff0c\u8ba9\u5b9e\u9a8c\u53f0\u77e5\u9053\u8981\u9a8c\u8bc1\u54ea\u4e00\u9875\u3002",
                  )}
                {firstUseStage === "run" &&
                  pickUiText(
                    locale,
                    "Step 2: Choose a lab mode or a saved template and start the run. Once a run is detected, continue into Runs & Blocks to inspect the result.",
                    "\u6b65\u9aa4 2\uff1a\u9009\u62e9\u5b9e\u9a8c\u6a21\u5f0f\u6216\u5df2\u4fdd\u5b58\u6a21\u677f\u5e76\u542f\u52a8\u8fd0\u884c\u3002\u7cfb\u7edf\u68c0\u6d4b\u5230 run \u4e4b\u540e\uff0c\u5c31\u53bb Runs & Blocks \u67e5\u770b\u7ed3\u679c\u3002",
                  )}
                {firstUseStage === "verify" &&
                  pickUiText(
                    locale,
                    "Step 3: Read the latest result, decide whether to rerun or refine, and only open Advanced Review if you need deeper governed comparison.",
                    "\u6b65\u9aa4 3\uff1a\u5148\u8bfb\u6700\u65b0\u7ed3\u679c\uff0c\u518d\u51b3\u5b9a\u662f\u91cd\u8dd1\u8fd8\u662f\u4f18\u5316\u6d41\u7a0b\uff1b\u53ea\u6709\u9700\u8981\u66f4\u6df1\u6cbb\u7406\u5bf9\u6bd4\u65f6\u624d\u6253\u5f00 Advanced Review\u3002",
                  )}
              </p>
              <p className="text-muted">
                {pickUiText(
                  locale,
                  `Step status: config ${firstUseProgress.configValid ? "\u2705" : "\u2b1c"} / run started ${firstUseProgress.runTriggered ? "\u2705" : "\u2b1c"} / result reviewed ${firstUseProgress.resultSeen ? "\u2705" : "\u2b1c"}`,
                  `\u6b65\u9aa4\u72b6\u6001\uff1a\u914d\u7f6e ${firstUseProgress.configValid ? "\u2705" : "\u2b1c"} / \u5df2\u542f\u52a8 ${firstUseProgress.runTriggered ? "\u2705" : "\u2b1c"} / \u5df2\u8bfb\u7ed3\u679c ${firstUseProgress.resultSeen ? "\u2705" : "\u2b1c"}`,
                )}
              </p>
              <div className="form-actions">
                {firstUseStage === "welcome" && (
                  <Button size="sm" onClick={() => onFirstUseStageChange("configure")}>
                    {pickUiText(locale, "Start step 1", "\u5f00\u59cb\u6b65\u9aa4 1")}
                  </Button>
                )}
                {canGoConfigure && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onFirstUseStageChange("configure")}
                  >
                    {pickUiText(locale, "Jump to configuration", "\u8df3\u5230\u914d\u7f6e")}
                  </Button>
                )}
                {(isCurrentStage("configure") || isCurrentStage("run")) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onFirstUseStageChange("run")}
                    disabled={!canGoRun}
                  >
                    {pickUiText(locale, "Configuration complete, continue to run", "\u914d\u7f6e\u5b8c\u6210\uff0c\u7ee7\u7eed\u8fd0\u884c")}
                  </Button>
                )}
                {canShowComplete && (
                  <Button size="sm" onClick={onCompleteFirstUse} disabled={!canCompleteFirstUse}>
                    {pickUiText(locale, "Complete first-run guide", "\u5b8c\u6210\u9996\u6b21\u5f15\u5bfc")}
                  </Button>
                )}
              </div>
              {firstUseStage === "configure" && !firstUseProgress.configValid && (
                <p className="text-muted">
                  {pickUiText(
                    locale,
                    "Please enter a valid baseUrl / startUrl (startUrl is optional) and configure successSelector.",
                    "\u8bf7\u8f93\u5165\u6709\u6548\u7684 baseUrl / startUrl\uff08startUrl \u53ef\u9009\uff09\uff0c\u5e76\u914d\u7f6e successSelector\u3002",
                  )}
                </p>
              )}
              {firstUseStage === "verify" && !firstUseProgress.resultSeen && (
                <p className="text-muted">
                  {pickUiText(
                    locale,
                    "A success or failure result has not been detected yet. Wait in Runs & Blocks before completing the guide.",
                    "\u7cfb\u7edf\u8fd8\u6ca1\u68c0\u6d4b\u5230\u6210\u529f\u6216\u5931\u8d25\u7ed3\u679c\u3002\u8bf7\u5148\u5728 Runs & Blocks \u770b\u5230\u7ed3\u679c\uff0c\u518d\u5b8c\u6210\u5f15\u5bfc\u3002",
                  )}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <Card className="mb-4" data-tour="launch-plan">
          <CardHeader>
            <CardTitle>
              {pickUiText(
                locale,
                "Launch-first path for the first result",
                "\u7b2c\u4e00\u4e2a\u7ed3\u679c\u7684 launch-first \u8def\u5f84",
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">{laneMapSummary}</p>
            <p className="text-muted">
              {pickUiText(
                locale,
                "This page only needs to do one job above the fold: configure the target, pick the lab mode, run it, then read Runs & Blocks.",
                "\u8fd9\u4e2a\u9875\u9762\u5728\u9996\u5c4f\u53ea\u9700\u8981\u505a\u4e00\u4ef6\u4e8b\uff1a\u5148\u914d\u7f6e\u76ee\u6807\uff0c\u518d\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u542f\u52a8\u8fd0\u884c\uff0c\u7136\u540e\u53bb Runs & Blocks \u8bfb\u7ed3\u679c\u3002",
              )}
            </p>
            <p className="text-muted">
              <strong>{firstUseStateTitle}</strong>
            </p>
            <p className="text-muted">{firstUseStateHint}</p>
            <div className="templates-grid mt-3">
              {launchChecklist.map((item) => (
                <Card key={item.title} className="template-card">
                  <CardHeader className="template-card-header">
                    <CardTitle>{item.title}</CardTitle>
                    <Badge variant={item.badgeVariant}>{item.status}</Badge>
                  </CardHeader>
                  <CardContent>
                    <p className="hint-text">{item.body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="form-actions mt-3">
              <Button
                size="sm"
                variant={firstUseProgress.runTriggered ? "default" : "secondary"}
                onClick={onGoToTasks}
                disabled={!firstUseProgress.runTriggered}
              >
                {pickUiText(locale, "Open Runs & Blocks", "\u6253\u5f00 Runs & Blocks")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onFirstUseStageChange("configure")}
              >
                {pickUiText(locale, "Back to target setup", "\u56de\u5230\u76ee\u6807\u914d\u7f6e")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4" data-tour="launch-modes">
          <CardHeader>
            <CardTitle>
              {pickUiText(
                locale,
                "Choose the lab mode for this target",
                "\u4e3a\u8fd9\u4e2a\u76ee\u6807\u9009\u62e9\u5b9e\u9a8c\u6a21\u5f0f",
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="hint-text">
              {pickUiText(
                locale,
                "Prooflane is strongest when you treat it like a browser lab first: pick the target, choose the experiment type, run it, and only move into advanced review when the result needs deeper comparison.",
                "Prooflane \u6700\u5f3a\u7684\u7528\u6cd5\u662f\u5148\u628a\u5b83\u5f53\u6210\u6d4f\u89c8\u5668\u5b9e\u9a8c\u53f0\uff1a\u5148\u9009\u76ee\u6807\u3001\u518d\u9009\u5b9e\u9a8c\u7c7b\u578b\u3001\u542f\u52a8\u5b9e\u9a8c\uff0c\u53ea\u6709\u7ed3\u679c\u9700\u8981\u66f4\u6df1\u5bf9\u6bd4\u65f6\u624d\u8fdb\u5165 Advanced Review\u3002",
              )}
            </p>
            <div className="templates-grid mt-3">
              {LAB_MODES.map((mode) => {
                const localizedMode = localizeLabMode(locale, mode);
                return (
                <Card key={mode.title} className="template-card">
                  <CardHeader className="template-card-header">
                    <CardTitle>{localizedMode.title}</CardTitle>
                    <Badge variant="secondary">{localizedMode.badge}</Badge>
                  </CardHeader>
                  <CardContent>
                    <p className="template-meta">{localizedMode.description}</p>
                    <p className="hint-text mt-2">{localizedMode.bestWhen}</p>
                  </CardContent>
                </Card>
              )})}
            </div>
          </CardContent>
        </Card>

        <div className="templates-section" data-tour="launch-actions">
          <div className="section-divider">
            <span className="section-divider-line" />
            <span className="section-divider-label">
              {pickUiText(locale, "Run from Stress Lab", "\u4ece Stress Lab \u542f\u52a8")}
            </span>
            <span className="section-divider-line" />
          </div>
          <p className="hint-text mb-4">
            {pickUiText(
              locale,
              "Keep this slice focused: launch one experiment first. Reusable journeys, fit checks, and version history stay below as later shortcuts.",
              "\u8fd9\u4e00\u5200\u5148\u4fdd\u6301\u805a\u7126\uff1a\u5148\u542f\u52a8\u4e00\u6b21\u5b9e\u9a8c\u3002\u53ef\u590d\u7528\u6d41\u7a0b\u3001\u76ee\u6807\u9002\u914d\u68c0\u67e5\u548c\u7248\u672c\u5386\u53f2\u90fd\u653e\u5728\u4e0b\u9762\u5f53 later shortcut\u3002",
            )}
          </p>
          <CommandGrid
            commands={commands}
            locale={locale}
            commandState={commandState}
            activeTab={activeTab}
            submittingId={submittingId}
            feedbackText={feedbackText}
            onActiveTabChange={onActiveTabChange}
            onRunCommand={onRunCommand}
          />
        </div>

        {/* Templates section */}
        {templates.length > 0 && (
          <div className="templates-section">
            <div className="section-divider">
              <span className="section-divider-line" />
              <span className="section-divider-label">
                {pickUiText(
                  locale,
                  "Later: reusable journeys",
                  "\u7a0d\u540e\uff1a\u53ef\u590d\u7528\u6d41\u7a0b",
                )}
              </span>
              <span className="section-divider-line" />
            </div>
            <p className="hint-text mb-4">
              {pickUiText(
                locale,
                "Use these after the first result exists. They help you rerun, compare target fit, and manage saved versions without taking over the first-use path.",
                "\u8fd9\u4e9b\u66f4\u9002\u5408\u653e\u5728\u7b2c\u4e00\u4e2a\u7ed3\u679c\u51fa\u6765\u4e4b\u540e\u518d\u7528\u3002\u5b83\u4eec\u53ef\u4ee5\u5e2e\u4f60\u91cd\u8dd1\u3001\u68c0\u67e5\u76ee\u6807\u9002\u914d\uff0c\u6216\u7ba1\u7406\u4fdd\u5b58\u7684\u7248\u672c\uff0c\u4f46\u4e0d\u5e94\u8be5\u53d6\u4ee3\u9996\u6b21\u4f7f\u7528\u4e3b\u7ebf\u3002",
              )}
            </p>
            <div className="templates-grid">
              {templates.map((tpl) => {
                const isSelected = selectedTemplateId === tpl.template_id;
                return (
                  <Card
                    key={tpl.template_id}
                    className={`template-card ${isSelected ? "active" : ""}`}
                  >
                    <CardHeader className="template-card-header">
                      <CardTitle>{tpl.name}</CardTitle>
                      <Badge variant="secondary">
                        {pickUiText(
                          locale,
                          `${tpl.params_schema.length} params`,
                          `${tpl.params_schema.length} 个参数`,
                        )}
                      </Badge>
                    </CardHeader>
                    <CardContent>
                      <p className="template-meta">
                        {pickUiText(
                          locale,
                          `Flow template: ${tpl.flow_id.slice(0, 8)}`,
                          `流程模板：${tpl.flow_id.slice(0, 8)}`,
                        )}
                        {tpl.policies?.otp?.required && pickUiText(locale, " / OTP", " / OTP")}
                        {pickUiText(
                          locale,
                          ` / timeout ${tpl.policies?.timeout_seconds ?? 120}s`,
                          ` / 超时 ${tpl.policies?.timeout_seconds ?? 120} 秒`,
                        )}
                      </p>
                      <p className="template-meta">
                        {pickUiText(
                          locale,
                          `Family ${(tpl.template_family_id ?? tpl.template_id).slice(0, 8)} / version v${tpl.version ?? 1}`,
                          `家族 ${(tpl.template_family_id ?? tpl.template_id).slice(0, 8)} / 版本 v${tpl.version ?? 1}`,
                        )}
                        {tpl.recommended ? pickUiText(locale, " / recommended", " / 已推荐") : ""}
                      </p>
                      {isSelected && (
                        <div className="mt-3">
                          <div className="field-group">
                            {tpl.params_schema.map((param) => (
                              <div key={param.key} className="field">
                                <label
                                  className="field-label"
                                  htmlFor={`template-${tpl.template_id}-${param.key}`}
                                >
                                  {param.description || param.key}
                                </label>
                                <input
                                  id={`template-${tpl.template_id}-${param.key}`}
                                  className="field-input"
                                  type={param.type === "secret" ? "password" : "text"}
                                  value={runParams[param.key] ?? ""}
                                  onChange={(e) =>
                                    onRunParamsChange({ ...runParams, [param.key]: e.target.value })
                                  }
                                  placeholder={pickUiText(
                                    locale,
                                    param.required ? "Required" : "Optional",
                                    param.required ? "必填" : "可选",
                                  )}
                                />
                              </div>
                            ))}
                          </div>
                          {!canCreateRun && (
                            <p className="text-muted mb-2">
                              {pickUiText(
                                locale,
                                `Fill in the required parameters before starting: ${missingRequiredTemplateParams.join(", ")}`,
                                `开始前请先填完必填参数：${missingRequiredTemplateParams.join(", ")}`,
                              )}
                            </p>
                          )}
                          <div className="form-actions">
                            <Button
                              size="sm"
                              onClick={handleCreateRunClick}
                              loading={isCreatingRun}
                              disabled={!canCreateRun}
                            >
                              {pickUiText(locale, "Start run", "启动运行")}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => void onForkTemplateVersion()}>
                              {pickUiText(locale, "Fork version", "派生版本")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void onMarkTemplateRecommended()}
                              disabled={tpl.recommended === true}
                            >
                              {tpl.recommended
                                ? pickUiText(locale, "Recommended", "已推荐")
                                : pickUiText(locale, "Mark recommended", "标记为推荐")}
                            </Button>
                          </div>
                          <div className="mt-3">
                            <p className="field-label">
                              {pickUiText(locale, "Target fit check", "目标适配检查")}
                            </p>
                            <p className="hint-text mt-2">
                              {pickUiText(
                                locale,
                                "Before you start a reusable journey, check whether this template still fits the target family you want to run against.",
                                "在启动可复用流程前，先确认这个模板是否仍然适配你准备运行的目标族。",
                              )}
                            </p>
                            <div className="field-row mt-2">
                              <label className="sr-only" htmlFor={`template-feasibility-${tpl.template_id}`}>
                                {pickUiText(locale, "Template target", "模板目标")}
                              </label>
                              <select
                                id={`template-feasibility-${tpl.template_id}`}
                                className="field-input"
                                value={feasibilityTarget}
                                onChange={(event) => setFeasibilityTarget(event.target.value)}
                              >
                                <option value="web.local">{"web.local"}</option>
                                <option value="web.ci">{"web.ci"}</option>
                                <option value="tauri.macos">{"tauri.macos"}</option>
                                <option value="swift.macos">{"swift.macos"}</option>
                              </select>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handleCheckFeasibility()}
                                loading={isCheckingFeasibility}
                              >
                                {pickUiText(locale, "Check target fit", "\u68c0\u67e5\u76ee\u6807\u9002\u914d")}
                              </Button>
                            </div>
                            {templateFeasibility && (
                              <div className="mt-2">
                                <p className="hint-text">
                                  {templateFeasibility.supported
                                    ? pickUiText(
                                        locale,
                                        `Supported on ${templateFeasibility.target}.`,
                                        `\u5728 ${templateFeasibility.target} \u4e0a\u53ef\u7528\u3002`,
                                      )
                                    : pickUiText(
                                        locale,
                                        `Not ready for ${templateFeasibility.target}.`,
                                        `\u76ee\u524d\u8fd8\u4e0d\u9002\u5408 ${templateFeasibility.target}\u3002`,
                                      )}
                                </p>
                                <p className="hint-text">
                                  {pickUiText(
                                    locale,
                                    `Required capabilities: ${templateFeasibility.required_capabilities.join(", ") || "none"}`,
                                    `\u6240\u9700\u80fd\u529b\uff1a${templateFeasibility.required_capabilities.join(", ") || "\u65e0"}`,
                                  )}
                                </p>
                                <p className="hint-text">
                                  {pickUiText(
                                    locale,
                                    `Blocked reasons: ${templateFeasibility.blocked_reasons.join(" | ") || "none"}`,
                                    `\u963b\u585e\u539f\u56e0\uff1a${templateFeasibility.blocked_reasons.join(" | ") || "\u65e0"}`,
                                  )}
                                </p>
                              </div>
                            )}
                            {feasibilityError && <p className="error-text mt-2">{feasibilityError}</p>}
                          </div>
                          {templateHistory.length > 0 && (
                            <div className="mt-3">
                              <p className="hint-text">
                                {pickUiText(
                                  locale,
                                  `Version history (${templateHistory.length})`,
                                  `版本历史（${templateHistory.length}）`,
                                )}
                              </p>
                              <ul
                                className="task-list mt-2"
                                aria-label={pickUiText(locale, "Template history", "模板历史")}
                              >
                                {templateHistory.slice(0, 4).map((item) => (
                                  <li key={item.template_id} className="task-item">
                                    <div className="task-item-info text-left">
                                      <strong>{`${item.name} \u00b7 v${item.version ?? 1}`}</strong>
                                      <p>
                                        {item.recommended
                                          ? pickUiText(locale, "Recommended version", "推荐版本")
                                          : item.parent_template_id
                                            ? pickUiText(
                                                locale,
                                                `Forked from ${item.parent_template_id.slice(0, 8)}`,
                                                `派生自 ${item.parent_template_id.slice(0, 8)}`,
                                              )
                                            : pickUiText(locale, "Family root", "模板家族根版本")}
                                      </p>
                                    </div>
                                    <Badge variant={item.recommended ? "default" : "secondary"}>
                                      {item.status ?? pickUiText(locale, "active", "启用中")}
                                    </Badge>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                      {!isSelected && (
                        <div className="mt-3">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              onSelectedTemplateIdChange(tpl.template_id);
                              onRunParamsChange(tpl.defaults ?? {});
                            }}
                          >
                            {pickUiText(locale, "Select template", "选择模板")}
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {templates.length === 0 && commandState === "success" && (
          <div className="templates-section">
            <div className="section-divider">
              <span className="section-divider-line" />
              <span className="section-divider-label">
                {pickUiText(locale, "Later: template quick start", "稍后：模板快速开始")}
              </span>
              <span className="section-divider-line" />
            </div>
            <EmptyState
              icon={
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M12 8v8M8 12h8" />
                </svg>
              }
              title={pickUiText(locale, "No reusable journeys yet", "还没有可复用流程")}
              description={pickUiText(
                locale,
                "Templates pin a saved browser journey and its inputs so you can rerun the same experiment quickly. Record and save a flow in Flow Studio to create one.",
                "模板会固定保存好的浏览器流程及其输入，这样你就能快速重跑同一类实验。想创建模板，请先在 Flow Studio 里录制并保存流程。",
              )}
            />
          </div>
        )}
      </div>
      <aside
        className={`quick-launch-sidebar ${canToggleSidebar && sidebarCollapsed ? "collapsed" : ""}`}
        data-tour="launch-parameters"
      >
        {canToggleSidebar && (
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={
              sidebarCollapsed
                ? pickUiText(locale, "Expand parameter panel", "展开参数面板")
                : pickUiText(locale, "Collapse parameter panel", "收起参数面板")
            }
          >
            {sidebarCollapsed ? "\u276F" : "\u276E"}
          </button>
        )}
        {showSidebarPanel && (
          <>
            <div className="section-divider">
              <span className="section-divider-line" />
              <span className="section-divider-label">
                {pickUiText(locale, "1. Configure target", "1. 配置目标")}
              </span>
              <span className="section-divider-line" />
            </div>
            <p className="hint-text mb-4">
              {pickUiText(
                locale,
                "This panel is the true first step. Set the target URL, optional start page, and success checkpoint before you choose the experiment mode.",
                "这个面板才是真正的第一步。先把目标 URL、可选起始页和 success checkpoint 设好，再去选择实验模式。",
              )}
            </p>
            <ParamsPanel params={params} locale={locale} onChange={onParamsChange} />
          </>
        )}
      </aside>
    </div>
  );
}

export default memo(QuickLaunchView);
