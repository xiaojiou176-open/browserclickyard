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

const TOUR_VIEW_GUIDES = {
  launch:
    "Stress Lab is where you begin. Confirm the target, choose a lab mode, and launch the first browser experiment.",
  tasks:
    "Runs & Blocks is where you read the latest result, inspect failures, and clear manual blockers before running again.",
  workshop:
    "Flow Studio is where you deepen the experiment by editing journeys, replaying steps, and tightening what the run just taught you.",
  review:
    "Advanced Review is the optional governed layer for comparing proof bundles, AI summaries, and historical matches after the result already exists.",
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
  const localizedTourViewGuides = {
    launch: pickUiText(
      locale,
      TOUR_VIEW_GUIDES.launch,
      "Stress Lab \u662f\u7b2c\u4e00\u7ad9\u3002\u5148\u786e\u8ba4\u76ee\u6807\uff0c\u518d\u9009\u62e9\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u7136\u540e\u542f\u52a8\u7b2c\u4e00\u6b21\u6d4f\u89c8\u5668\u5b9e\u9a8c\u3002",
    ),
    tasks: pickUiText(
      locale,
      TOUR_VIEW_GUIDES.tasks,
      "Runs & Blocks \u7528\u6765\u5148\u8bfb\u6700\u65b0\u7ed3\u679c\u3001\u770b\u5931\u8d25\u4e0e\u6682\u505c\u539f\u56e0\uff0c\u518d\u51b3\u5b9a\u662f\u5426\u7ee7\u7eed\u3002",
    ),
    workshop: pickUiText(
      locale,
      TOUR_VIEW_GUIDES.workshop,
      "Flow Studio \u8d1f\u8d23\u66f4\u6df1\u4e00\u5c42\u7684\u6d41\u7a0b\u7f16\u8f91\u3001\u6b65\u9aa4\u91cd\u653e\u548c\u5b9e\u9a8c\u4f18\u5316\u3002",
    ),
    review: pickUiText(
      locale,
      TOUR_VIEW_GUIDES.review,
      "Advanced Review \u662f\u53ef\u9009\u6cbb\u7406\u5c42\uff0c\u53ea\u6709\u5728\u7ed3\u679c\u5df2\u7ecf\u5b58\u5728\u4e14\u9700\u8981 proof\u3001AI \u6458\u8981\u6216\u5386\u53f2\u5bf9\u6bd4\u65f6\u624d\u6253\u5f00\u3002",
    ),
  } as const;
  const localizedSteps: TourStep[] = [
    {
      selector: '[data-tour="welcome"]',
      title: pickUiText(
        locale,
        "Step 1: Start from the target, not from the room list",
        "\u6b65\u9aa4 1\uff1a\u5148\u4ece\u76ee\u6807\u5f00\u59cb\uff0c\u800c\u4e0d\u662f\u5148\u770b\u623f\u95f4\u5217\u8868",
      ),
      body: `${laneMapSummary} ${recommendedFirstPath}`,
      position: "bottom",
    },
    {
      selector: '[data-tour="tab-launch"]',
      title: pickUiText(locale, "Step 2: Launch from Stress Lab", "\u6b65\u9aa4 2\uff1a\u4ece Stress Lab \u53d1\u8d77\u5b9e\u9a8c"),
      body: localizedTourViewGuides.launch,
      position: "bottom",
    },
    {
      selector: '[data-tour="tab-tasks"]',
      title: pickUiText(locale, "Step 3: Read the result in Runs & Blocks", "\u6b65\u9aa4 3\uff1a\u5728 Runs & Blocks \u8bfb\u7ed3\u679c"),
      body: localizedTourViewGuides.tasks,
      position: "bottom",
    },
    {
      selector: '[data-tour="tab-workshop"]',
      title: pickUiText(locale, "Step 4: Deepen the journey in Flow Studio", "\u6b65\u9aa4 4\uff1a\u5728 Flow Studio \u6df1\u5316\u6d41\u7a0b"),
      body: localizedTourViewGuides.workshop,
      position: "bottom",
    },
    {
      selector: '[data-tour="tab-review"]',
      title: pickUiText(
        locale,
        "Step 5: Open Advanced Review only when needed",
        "\u6b65\u9aa4 5\uff1a\u53ea\u6709\u9700\u8981\u65f6\u624d\u6253\u5f00 Advanced Review",
      ),
      body: localizedTourViewGuides.review,
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
