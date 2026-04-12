import { type CSSProperties, memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { useModalA11y } from "../hooks/useModalA11y";
import { Button } from "./ui";

interface TourStep {
  selector: string;
  title: string;
  body: string;
  position?: "bottom" | "top" | "left" | "right";
}

const LANE_MAP_SUMMARY =
  "Start with a target URL in Stress Lab, choose the kind of browser experiment you want to run, inspect the latest result in Runs & Blocks, and open Advanced Review only when you need deeper governed comparison.";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

const TOUR_PAGE_GUIDES = {
  plan:
    "This page is not a whole-product map. It exists to get one first result on screen: configure the target, choose a mode, run it, then read Runs & Blocks.",
  parameters:
    "Use the parameter panel to set the base URL, optional start URL, and success checkpoint before you try to launch anything.",
  modes:
    "Choose one lab mode that matches the first question you want answered. You do not need every lane on the first pass.",
  actions:
    "Launch from the command grid or a saved template only after the target is configured. Reusable shortcuts stay secondary to the first run.",
  tasks:
    "After launch, move to Runs & Blocks to read the verdict or clear a waiting gate such as OTP or manual input.",
} as const;

interface OnboardingTourProps {
  active: boolean;
  locale?: UiLocale;
  onComplete: () => void;
}

function OnboardingTour({
  active,
  locale = DEFAULT_UI_LOCALE,
  onComplete,
}: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const laneMapSummary = pickUiText(
    locale,
    LANE_MAP_SUMMARY,
    "\u5148\u5728 Stress Lab \u586b\u76ee\u6807 URL\u3001\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u518d\u53bb Runs & Blocks \u8bfb\u6700\u65b0\u7ed3\u679c\uff1b\u53ea\u6709\u9700\u8981\u66f4\u6df1\u6cbb\u7406\u5bf9\u6bd4\u65f6\u624d\u6253\u5f00 Advanced Review\u3002",
  );
  const recommendedFirstPath = pickUiText(
    locale,
    RECOMMENDED_FIRST_PATH,
    "\u63a8\u8350\u8def\u5f84\uff1a\u5148\u586b URL\uff0c\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u542f\u52a8\u5b9e\u9a8c\uff0c\u518d\u8bfb\u7ed3\u679c\uff1b\u6700\u540e\u624d\u8fdb\u5165 Advanced Review\u3002",
  );
  const localizedTourPageGuides = {
    plan: pickUiText(
      locale,
      TOUR_PAGE_GUIDES.plan,
      "这个页面不是整张产品地图，而是为了把第一个结果先跑出来：先配目标、再选模式、再运行，最后去 Runs & Blocks 读结论。",
    ),
    parameters: pickUiText(
      locale,
      TOUR_PAGE_GUIDES.parameters,
      "先在参数面板里设置 base URL、可选 start URL 和 success checkpoint，然后再尝试发起实验。",
    ),
    modes: pickUiText(
      locale,
      TOUR_PAGE_GUIDES.modes,
      "先选一个最符合当前问题的实验模式就够了，第一次不需要把所有 lane 都走一遍。",
    ),
    actions: pickUiText(
      locale,
      TOUR_PAGE_GUIDES.actions,
      "只有在目标配置好之后，才从 command grid 或已保存模板发起运行。可复用快捷方式仍然应该排在首跑之后。",
    ),
    tasks: pickUiText(
      locale,
      TOUR_PAGE_GUIDES.tasks,
      "发起运行后，下一站就是 Runs & Blocks。在那里读结论，或者清掉 OTP / 手工输入这样的等待闸门。",
    ),
  } as const;
  const localizedSteps: TourStep[] = [
    {
      selector: '[data-tour="launch-plan"]',
      title: pickUiText(
        locale,
        "Step 1: Start from the target, not from the room list",
        "\u6b65\u9aa4 1\uff1a\u5148\u4ece\u76ee\u6807\u5f00\u59cb\uff0c\u800c\u4e0d\u662f\u5148\u770b\u623f\u95f4\u5217\u8868",
      ),
      body: `${localizedTourPageGuides.plan} ${laneMapSummary} ${recommendedFirstPath}`,
      position: "bottom",
    },
    {
      selector: '[data-tour="launch-parameters"]',
      title: pickUiText(
        locale,
        "Step 2: Configure the target first",
        "\u6b65\u9aa4 2\uff1a\u5148\u914d\u7f6e\u76ee\u6807",
      ),
      body: localizedTourPageGuides.parameters,
      position: "bottom",
    },
    {
      selector: '[data-tour="launch-modes"]',
      title: pickUiText(
        locale,
        "Step 3: Choose one lab mode",
        "\u6b65\u9aa4 3\uff1a\u9009\u4e00\u4e2a\u5b9e\u9a8c\u6a21\u5f0f",
      ),
      body: localizedTourPageGuides.modes,
      position: "bottom",
    },
    {
      selector: '[data-tour="launch-actions"]',
      title: pickUiText(
        locale,
        "Step 4: Start the run from this page",
        "\u6b65\u9aa4 4\uff1a\u5728\u8fd9\u4e2a\u9875\u9762\u53d1\u8d77\u8fd0\u884c",
      ),
      body: localizedTourPageGuides.actions,
      position: "bottom",
    },
    {
      selector: '[data-tour="tab-tasks"]',
      title: pickUiText(
        locale,
        "Step 5: Move to Runs & Blocks next",
        "\u6b65\u9aa4 5\uff1a\u4e0b\u4e00\u7ad9\u8f6c\u5230 Runs & Blocks",
      ),
      body: localizedTourPageGuides.tasks,
      position: "bottom",
    },
  ];

  const currentStep = localizedSteps[step];
  const handleSkip = useCallback(() => {
    setStep(0);
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    if (!active) {
      return;
    }
    if (typeof document === "undefined") {
      return;
    }
    const consoleRoot = document.querySelector(".console-root");
    const previousAriaHidden = consoleRoot?.getAttribute("aria-hidden");
    const hadInert = consoleRoot?.hasAttribute("inert") ?? false;
    const previousBodyOverflow = document.body.style.overflow;

    consoleRoot?.setAttribute("aria-hidden", "true");
    consoleRoot?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";

    return () => {
      if (consoleRoot) {
        if (previousAriaHidden == null) {
          consoleRoot.removeAttribute("aria-hidden");
        } else {
          consoleRoot.setAttribute("aria-hidden", previousAriaHidden);
        }
        if (!hadInert) {
          consoleRoot.removeAttribute("inert");
        }
      }
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [active]);

  useEffect(() => {
    if (!active || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      handleSkip();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [active, handleSkip]);

  useModalA11y({
    active,
    containerRef: popoverRef,
    onEscape: handleSkip,
  });

  const handleNext = useCallback(() => {
    if (step < localizedSteps.length - 1) {
      setStep((s) => s + 1);
    } else {
      setStep(0);
      onComplete();
    }
  }, [localizedSteps.length, onComplete, step]);

  const handlePrev = useCallback(() => {
    if (step > 0) {
      setStep((s) => s - 1);
    }
  }, [step]);

  if (!active) {
    return null;
  }

  const rect =
    typeof document !== "undefined" && currentStep
      ? (document.querySelector(currentStep.selector)?.getBoundingClientRect() ?? null)
      : null;

  const PAD = 8;
  const spotlightStyle = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : { top: "50%", left: "50%", width: 0, height: 0 };

  const popoverStyle: CSSProperties = {};
  if (rect) {
    const pos = currentStep?.position ?? "bottom";
    if (pos === "bottom") {
      popoverStyle.top = rect.bottom + PAD + 12;
      popoverStyle.left = Math.max(16, rect.left + rect.width / 2 - 180);
    } else if (pos === "top") {
      popoverStyle.bottom = window.innerHeight - rect.top + PAD + 12;
      popoverStyle.left = Math.max(16, rect.left + rect.width / 2 - 180);
    }
  } else {
    popoverStyle.top = "50%";
    popoverStyle.left = "50%";
    popoverStyle.transform = "translate(-50%, -50%)";
  }

  const modal = (
    <>
      <button
        type="button"
        className="tour-backdrop"
        aria-label={pickUiText(locale, "Close first-run guide", "关闭首次引导")}
        tabIndex={-1}
        onClick={handleSkip}
        data-testid="onboarding-close-backdrop"
        style={{ border: "none", padding: 0 }}
      />
      <div className="tour-spotlight" style={spotlightStyle} aria-hidden="true" />
      <div
        ref={popoverRef}
        className="tour-popover"
        style={popoverStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
      >
        <div className="tour-popover-header">
          <h3 id={titleId}>{currentStep?.title}</h3>
          <span className="tour-step-count">{`${step + 1} / ${localizedSteps.length}`}</span>
        </div>
        <div className="tour-popover-body">
          <p id={descId}>{currentStep?.body}</p>
        </div>
        <div className="tour-popover-footer">
          <div className="tour-dots" aria-hidden="true">
            {localizedSteps.map((_, i) => (
              <span key={i} className={`tour-dot ${i === step ? "active" : ""}`} />
            ))}
          </div>
          <div className="flex-row gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleSkip}
              data-testid="onboarding-skip"
            >
              {pickUiText(locale, "Remind me later", "\u7a0d\u540e\u63d0\u9192\u6211")}
            </Button>
            {step > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handlePrev}
                data-testid="onboarding-prev"
              >
                {pickUiText(locale, "Back", "\u8fd4\u56de")}
              </Button>
            )}
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleNext}
              data-testid={step === localizedSteps.length - 1 ? "onboarding-start" : "onboarding-next"}
            >
              {step === localizedSteps.length - 1
                ? pickUiText(locale, "Start using Stress Lab", "\u5f00\u59cb\u4f7f\u7528 Stress Lab")
                : pickUiText(locale, "Next", "\u4e0b\u4e00\u6b65")}
            </Button>
          </div>
        </div>
      </div>
    </>
  );

  if (typeof document === "undefined") {
    return modal;
  }

  return createPortal(modal, document.body);
}

export default memo(OnboardingTour);
