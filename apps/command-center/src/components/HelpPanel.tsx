import { memo, useId, useRef } from "react";
import type { AppView } from "../hooks/useAppStore";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { useModalA11y } from "../hooks/useModalA11y";
import { Button } from "./ui";

interface HelpPanelProps {
  activeView: AppView;
  locale?: UiLocale;
  onClose: () => void;
  onRestartTour: () => void;
}

const LANE_MAP_SUMMARY =
  "Start with a target URL in Stress Lab, choose the kind of browser experiment you want to run, inspect the latest result in Runs & Blocks, and open Advanced Review only when you need deeper governed comparison.";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

const LANE_GUIDES = [
  {
    key: "launch",
    label: "Stress Lab",
    guide:
      "Stress Lab is the URL-first entry. Set the target you want to probe, choose the lab mode that fits the question, and launch the first experiment.",
  },
  {
    key: "tasks",
    label: "Runs & Blocks",
    guide:
      "Runs & Blocks is the lab inbox. Read the latest result, inspect failures, and clear waiting steps before you run again.",
  },
  {
    key: "workshop",
    label: "Flow Studio",
    guide:
      "Flow Studio is the deeper lab area for editing journeys, replaying steps, and tightening the next experiment after you learn from a run.",
  },
  {
    key: "review",
    label: "Advanced Review",
    guide:
      "Advanced Review is the optional governed compare layer. Use it after the lab result exists and you need proof bundles, AI summaries, or historical comparison.",
  },
] as const;

const viewHelp: Record<
  AppView,
  { title: string; desc: string; steps: { title: string; desc: string }[] }
> = {
  launch: {
    title: "Stress Lab",
    desc: "Start from the target you want to test, choose the experiment type, and launch the first browser run from one place.",
    steps: [
      {
        title: "Set the target first",
        desc: "Enter the target site URL, or keep the managed localhost target when you are testing a local WebUI.",
      },
      {
        title: "Choose the lab mode",
        desc: "Pick explore, load, perf, chaos, visual, or accessibility based on the question you want the experiment to answer.",
      },
      {
        title: "Launch the experiment",
        desc: "Start from a command card or a reusable journey template. The run moves into the background as soon as you launch it.",
      },
      {
        title: "Read the latest result in Runs & Blocks",
        desc: "Switch to Runs & Blocks to inspect live status, logs, failures, and manual blocks before you decide what to do next.",
      },
    ],
  },
  tasks: {
    title: "Runs & Blocks",
    desc: "This is the run inbox for reading experiment results, troubleshooting failures, and clearing manual blockers.",
    steps: [
      {
        title: "Find the latest run",
        desc: "Use the command lane and workflow lane to separate direct command runs from reusable journey runs.",
      },
      {
        title: "Read the result before reacting",
        desc: "Selecting a run reveals the latest outcome, status, and waiting context on the right so you do not have to infer it from raw logs.",
      },
      {
        title: "Clear blockers from the inbox",
        desc: "When a run pauses for OTP or operator confirmation, use the Manual Gate panel here instead of guessing what the run is waiting for.",
      },
      {
        title: "Use the log stream only as evidence detail",
        desc: "The bottom log panel is for debugging depth after you already know which run and result you care about.",
      },
    ],
  },
  workshop: {
    title: "Flow Studio",
    desc: "Use this view to inspect and refine the journey behind the lab result, then replay steps with screenshot evidence.",
    steps: [
      {
        title: "Check the latest lab verdict first",
        desc: "The top card tells you whether the replay passed, where it failed, and what the next experiment should be.",
      },
      {
        title: "Edit the journey carefully",
        desc: "Change step order, action types, and targeting only after you know what the previous run actually learned.",
      },
      {
        title: "Replay one step at a time",
        desc: "Run a single step first, then confirm the result with the output and screenshots before you rerun the whole journey.",
      },
      {
        title: "Use the report lenses",
        desc: "The report-lens section helps you map the current journey back to exploration, load, performance, resilience, visual, and accessibility findings.",
      },
    ],
  },
  review: {
    title: "Advanced Review",
    desc: "Use this optional view when you already have a lab result and need deeper governed comparison, proof bundles, or AI-assisted reading.",
    steps: [
      {
        title: "Open it only after a real run exists",
        desc: "Advanced Review is not the first stop. Start in Stress Lab, then come here after Runs & Blocks shows a real result worth comparing.",
      },
      {
        title: "Compare governed evidence together",
        desc: "Use this surface to line up runs, proof bundles, AI summaries, and historical matches instead of jumping across separate tools.",
      },
      {
        title: "Use differences to choose the next move",
        desc: "When the evidence does not match your expectation, go back to Runs & Blocks for live state or Flow Studio for refinement.",
      },
      {
        title: "Treat it as an enhanced layer",
        desc: "Advanced Review helps you decide whether to rerun, refine, or promote after the experiment result is already legible.",
      },
    ],
  },
};

function HelpPanel({
  activeView,
  locale = DEFAULT_UI_LOCALE,
  onClose,
  onRestartTour,
}: HelpPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const info = viewHelp[activeView];
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
  const localizedLaneGuides = LANE_GUIDES.map((view) => {
    if (view.key === "launch") {
      return {
        ...view,
        label: pickUiText(locale, view.label, "\u538b\u529b\u5b9e\u9a8c\u5ba4"),
        guide: pickUiText(
          locale,
          view.guide,
          "Stress Lab \u662f URL-first \u5165\u53e3\u3002\u5148\u8bbe\u76ee\u6807\uff0c\u518d\u9009\u5b9e\u9a8c\u6a21\u5f0f\uff0c\u7136\u540e\u542f\u52a8\u7b2c\u4e00\u6b21\u5b9e\u9a8c\u3002",
        ),
      };
    }
    if (view.key === "tasks") {
      return {
        ...view,
        label: pickUiText(locale, view.label, "\u8fd0\u884c\u4e0e\u963b\u585e"),
        guide: pickUiText(
          locale,
          view.guide,
          "Runs & Blocks \u662f\u7ed3\u679c\u6536\u4ef6\u7bb1\u3002\u5148\u8bfb\u6700\u65b0\u7ed3\u679c\u3001\u770b\u5931\u8d25\u548c\u7b49\u5f85\u6b65\u9aa4\uff0c\u518d\u51b3\u5b9a\u4e0b\u4e00\u6b65\u3002",
        ),
      };
    }
    if (view.key === "workshop") {
      return {
        ...view,
        label: pickUiText(locale, view.label, "\u6d41\u7a0b\u5de5\u4f5c\u5ba4"),
        guide: pickUiText(
          locale,
          view.guide,
          "Flow Studio \u7528\u6765\u7ee7\u7eed\u7f16\u8f91\u6d41\u7a0b\u3001\u91cd\u653e\u6b65\u9aa4\uff0c\u5e76\u6839\u636e\u521a\u624d\u90a3\u6b21 run \u7684\u53d1\u73b0\u7ee7\u7eed\u4f18\u5316\u3002",
        ),
      };
    }
    return {
      ...view,
      label: pickUiText(locale, view.label, "\u9ad8\u7ea7\u5ba1\u67e5"),
      guide: pickUiText(
        locale,
        view.guide,
        "Advanced Review \u662f\u53ef\u9009\u6cbb\u7406\u5c42\u3002\u53ea\u6709\u5728\u5b9e\u9a8c\u7ed3\u679c\u5df2\u7ecf\u5b58\u5728\u4e14\u9700\u8981 proof\u3001AI \u6458\u8981\u6216\u5386\u53f2\u5bf9\u6bd4\u65f6\u624d\u6253\u5f00\u3002",
      ),
    };
  });
  const localizedInfo = {
    title: pickUiText(locale, info.title, info.title),
    desc: pickUiText(
      locale,
      info.desc,
      activeView === "launch"
        ? "\u4ece\u76ee\u6807\u51fa\u53d1\u3001\u9009\u62e9\u5b9e\u9a8c\u7c7b\u578b\uff0c\u518d\u5728\u4e00\u4e2a\u754c\u9762\u91cc\u542f\u52a8\u7b2c\u4e00\u6b21\u6d4f\u89c8\u5668\u8fd0\u884c\u3002"
        : activeView === "tasks"
          ? "\u8fd9\u91cc\u662f\u7ed3\u679c\u6536\u4ef6\u7bb1\uff0c\u7528\u6765\u8bfb\u5b9e\u9a8c\u7ed3\u679c\u3001\u6392\u67e5\u5931\u8d25\uff0c\u5e76\u5904\u7406\u4eba\u5de5\u963b\u585e\u3002"
          : activeView === "workshop"
            ? "\u8fd9\u91cc\u7528\u6765\u7ee7\u7eed\u8c03\u6574\u6d41\u7a0b\u3001\u91cd\u653e\u6b65\u9aa4\uff0c\u5e76\u628a\u5b9e\u9a8c\u91cc\u5b66\u5230\u7684\u5185\u5bb9\u56de\u5199\u6210\u66f4\u7a33\u7684 journey\u3002"
            : "\u8fd9\u91cc\u53ea\u5728\u4f60\u5df2\u7ecf\u6709\u5b9e\u9a8c\u7ed3\u679c\u4e14\u9700\u8981\u66f4\u6df1\u6cbb\u7406\u5bf9\u6bd4\u3001proof bundle \u6216 AI \u9605\u8bfb\u65f6\u4f7f\u7528\u3002",
    ),
    steps: info.steps.map((step, index) => ({
      title: pickUiText(
        locale,
        step.title,
        activeView === "launch"
          ? [
              "\u5148\u8bbe\u76ee\u6807",
              "\u9009\u62e9\u5b9e\u9a8c\u6a21\u5f0f",
              "\u542f\u52a8\u5b9e\u9a8c",
              "\u5728 Runs & Blocks \u8bfb\u7ed3\u679c",
            ][index] ?? step.title
          : activeView === "tasks"
            ? [
                "\u5148\u627e\u5230\u6700\u65b0\u8fd0\u884c",
                "\u5148\u8bfb\u7ed3\u679c\u518d\u53cd\u5e94",
                "\u5728\u6536\u4ef6\u7bb1\u91cc\u6e05\u963b\u585e",
                "\u628a\u65e5\u5fd7\u5f53\u6210\u8bc1\u636e\u7ec6\u8282",
              ][index] ?? step.title
            : activeView === "workshop"
              ? [
                  "\u5148\u770b\u6700\u65b0\u5b9e\u9a8c\u7ed3\u8bba",
                  "\u8c28\u614e\u4fee\u6539\u6d41\u7a0b",
                  "\u9010\u6b65\u91cd\u653e",
                  "\u4f7f\u7528\u62a5\u544a\u89c6\u89d2",
                ][index] ?? step.title
              : [
                  "\u53ea\u5728\u5df2\u6709\u7ed3\u679c\u540e\u6253\u5f00",
                  "\u628a\u6cbb\u7406\u8bc1\u636e\u653e\u5230\u4e00\u8d77\u770b",
                  "\u7528\u5dee\u5f02\u51b3\u5b9a\u4e0b\u4e00\u6b65",
                  "\u628a\u5b83\u5f53\u589e\u5f3a\u5c42\u800c\u4e0d\u662f\u7b2c\u4e00\u7ad9",
                ][index] ?? step.title,
      ),
      desc: pickUiText(
        locale,
        step.desc,
        activeView === "launch"
          ? [
              "\u586b\u5199\u76ee\u6807 URL\uff1b\u5982\u679c\u4f60\u6d4b\u7684\u662f\u672c\u5730 WebUI\uff0c\u4e5f\u53ef\u4ee5\u7ee7\u7eed\u7528\u6258\u7ba1 localhost \u76ee\u6807\u3002",
              "\u6839\u636e\u95ee\u9898\u9009\u62e9 explore\u3001load\u3001perf\u3001chaos\u3001visual \u6216 accessibility\u3002",
              "\u4ece\u547d\u4ee4\u5361\u7247\u6216\u53ef\u590d\u7528\u6a21\u677f\u542f\u52a8\uff1b\u8fd0\u884c\u4e00\u5f00\u59cb\u5c31\u4f1a\u8fdb\u5165\u540e\u53f0\u3002",
              "\u53bb Runs & Blocks \u770b\u72b6\u6001\u3001\u65e5\u5fd7\u3001\u5931\u8d25\u548c\u4eba\u5de5\u963b\u585e\uff0c\u518d\u51b3\u5b9a\u4e0b\u4e00\u6b65\u3002",
            ][index] ?? step.desc
          : activeView === "tasks"
            ? [
                "\u628a\u76f4\u63a5\u547d\u4ee4\u8fd0\u884c\u548c\u53ef\u590d\u7528\u6d41\u7a0b\u8fd0\u884c\u5206\u5f00\u770b\uff0c\u5148\u9501\u5b9a\u4f60\u771f\u6b63\u5173\u5fc3\u7684\u90a3\u6761\u8bb0\u5f55\u3002",
                "\u9009\u4e2d\u4e00\u6761\u8fd0\u884c\u540e\uff0c\u53f3\u4fa7\u4f1a\u5148\u7ed9\u4f60\u7ed3\u679c\u3001\u72b6\u6001\u548c\u7b49\u5f85\u4e0a\u4e0b\u6587\uff0c\u800c\u4e0d\u662f\u903c\u4f60\u5148\u8bfb\u539f\u59cb\u65e5\u5fd7\u3002",
                "\u5f53\u8fd0\u884c\u56e0\u4e3a OTP \u6216\u4eba\u5de5\u786e\u8ba4\u6682\u505c\u65f6\uff0c\u5728\u8fd9\u91cc\u5904\u7406\uff0c\u4e0d\u8981\u9760\u731c\u3002",
                "\u5e95\u90e8\u65e5\u5fd7\u53ea\u5728\u4f60\u5df2\u7ecf\u77e5\u9053\u54ea\u6761\u8fd0\u884c\u503c\u5f97\u8ffd\u4e4b\u540e\u518d\u770b\u3002",
              ][index] ?? step.desc
            : activeView === "workshop"
              ? [
                  "\u5148\u786e\u8ba4 replay \u5230\u5e95\u662f\u901a\u8fc7\u3001\u5931\u8d25\uff0c\u8fd8\u662f\u5361\u5728\u4e86\u54ea\u91cc\u3002",
                  "\u53ea\u6709\u5728\u4f60\u77e5\u9053\u4e0a\u4e00\u6b21 run \u5b66\u5230\u4e86\u4ec0\u4e48\u4e4b\u540e\uff0c\u518d\u53bb\u6539\u6b65\u9aa4\u987a\u5e8f\u3001\u52a8\u4f5c\u548c\u5b9a\u4f4d\u3002",
                  "\u5148\u91cd\u653e\u5355\u6b65\uff0c\u518d\u770b\u8f93\u51fa\u548c\u622a\u56fe\uff0c\u518d\u51b3\u5b9a\u8981\u4e0d\u8981\u5168\u91cf\u91cd\u8dd1\u3002",
                  "\u7528\u8fd9\u4e9b lens \u628a\u5f53\u524d\u6d41\u7a0b\u548c explore/load/perf/resilience/visual/a11y \u7ed3\u679c\u91cd\u65b0\u5bf9\u5e94\u8d77\u6765\u3002",
                ][index] ?? step.desc
              : [
                  "Advanced Review \u4e0d\u662f\u7b2c\u4e00\u7ad9\uff1b\u5148\u5728 Stress Lab \u53d1\u8d77\u5b9e\u9a8c\uff0c\u518d\u5728 Runs & Blocks \u786e\u8ba4\u7ed3\u679c\u3002",
                  "\u628a runs\u3001proof bundles\u3001AI \u6458\u8981\u548c\u5386\u53f2\u76f8\u4f3c\u6848\u4f8b\u653e\u5728\u540c\u4e00\u4e2a\u8868\u9762\u4e0a\u8bfb\u3002",
                  "\u5982\u679c\u8bc1\u636e\u548c\u9884\u671f\u4e0d\u4e00\u81f4\uff0c\u56de\u5230 Runs & Blocks \u770b live \u72b6\u6001\uff0c\u6216\u53bb Flow Studio \u7ee7\u7eed\u4fee\u6d41\u7a0b\u3002",
                  "\u5b83\u662f\u589e\u5f3a\u5c42\uff0c\u4e0d\u662f\u4e3b\u5165\u53e3\uff1b\u4e3b\u5165\u53e3\u8fd8\u662f target-first \u7684 stress lab \u8def\u5f84\u3002",
                ][index] ?? step.desc,
      ),
    })),
  };

  useModalA11y({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
  });

  return (
    <>
      <button
        type="button"
        className="help-panel-overlay"
        aria-label={pickUiText(locale, "Help panel backdrop", "帮助面板背景层")}
        tabIndex={-1}
        onClick={onClose}
        data-testid="help-panel-overlay"
        style={{ border: "none", padding: 0 }}
      />
      <aside
        ref={panelRef}
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
      >
        <div className="help-panel-header">
          <h2 id={titleId}>{pickUiText(locale, "Help", "\u5e2e\u52a9")}</h2>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label={pickUiText(locale, "Close help panel", "\u5173\u95ed\u5e2e\u52a9\u9762\u677f")}
            data-testid="help-panel-close"
          >
            {"\u2715"}
          </Button>
        </div>
        <div className="help-panel-body">
          <div className="help-section">
            <h3>{pickUiText(locale, "Stress-lab path", "\u538b\u529b\u5b9e\u9a8c\u8def\u5f84")}</h3>
            <p>{laneMapSummary}</p>
            <p>{recommendedFirstPath}</p>
            <ol className="help-step-list">
              {localizedLaneGuides.map((view, index) => (
                <li key={view.key} className="help-step-item">
                  <span className="help-step-num">{index + 1}</span>
                  <div className="help-step-content">
                    <strong>{view.label}</strong>
                    <p>{view.guide}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* Current view help */}
          <div className="help-section">
            <h3>{localizedInfo.title}</h3>
            <p id={descId}>{localizedInfo.desc}</p>
          </div>

          <div className="help-section">
            <h3>{pickUiText(locale, "Steps", "\u6b65\u9aa4")}</h3>
            <ol className="help-step-list">
              {localizedInfo.steps.map((s, i) => (
                <li key={i} className="help-step-item">
                  <span className="help-step-num">{i + 1}</span>
                  <div className="help-step-content">
                    <strong>{s.title}</strong>
                    <p>{s.desc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="help-section">
            <h3>{pickUiText(locale, "FAQ", "\u5e38\u89c1\u95ee\u9898")}</h3>
            <details className="help-faq-item">
              <summary>
                {pickUiText(
                  locale,
                  "Why don't I see a result after starting an experiment?",
                  "\u4e3a\u4ec0\u4e48\u542f\u52a8\u5b9e\u9a8c\u540e\u8fd8\u770b\u4e0d\u5230\u7ed3\u679c\uff1f",
                )}
              </summary>
              <p>
                {pickUiText(
                  locale,
                  "Conclusion: the run record was not written into the Runs & Blocks list yet. Action: switch to Runs & Blocks, click Refresh, and try again. Troubleshooting entry: if the list is still empty, inspect the run log and backend service status.",
                  "\u7ed3\u8bba\uff1a\u8fd9\u6761\u8fd0\u884c\u8bb0\u5f55\u8fd8\u6ca1\u8fdb\u5165 Runs & Blocks \u5217\u8868\u3002\u52a8\u4f5c\uff1a\u5207\u5230 Runs & Blocks\uff0c\u70b9 Refresh\uff0c\u518d\u8bd5\u4e00\u6b21\u3002\u6392\u67e5\u5165\u53e3\uff1a\u5982\u679c\u5217\u8868\u8fd8\u662f\u7a7a\u7684\uff0c\u5c31\u770b run log \u548c backend service \u72b6\u6001\u3002",
                )}
              </p>
            </details>
            <details className="help-faq-item">
              <summary>
                {pickUiText(
                  locale,
                  "How do I configure the target site URL?",
                  "\u600e\u4e48\u914d\u7f6e\u76ee\u6807\u7ad9\u70b9 URL\uff1f",
                )}
              </summary>
              <p>
                {pickUiText(
                  locale,
                  "Fill in the Target site URL (BASE_URL) field in the parameter panel on the right. For Route B today, localhost-first targets are the safest path, and the default value points at the managed local development target.",
                  "\u5728\u53f3\u4fa7\u53c2\u6570\u9762\u677f\u91cc\u586b\u5199 Target site URL\uff08BASE_URL\uff09\u3002\u6309\u5f53\u524d Route B \u8fb9\u754c\uff0clocalhost-first \u76ee\u6807\u6700\u7a33\uff0c\u9ed8\u8ba4\u503c\u6307\u5411\u6258\u7ba1\u7684\u672c\u5730\u5f00\u53d1\u76ee\u6807\u3002",
                )}
              </p>
            </details>
            <details className="help-faq-item">
              <summary>{pickUiText(locale, "What is a flow draft?", "\u4ec0\u4e48\u662f flow draft\uff1f")}</summary>
              <p>
                {pickUiText(
                  locale,
                  "Once recording starts, the system saves an editable step list automatically. You can update it in Flow Studio and replay it later.",
                  "\u5f55\u5236\u4e00\u5f00\u59cb\uff0c\u7cfb\u7edf\u5c31\u4f1a\u81ea\u52a8\u4fdd\u5b58\u4e00\u4efd\u53ef\u7f16\u8f91\u6b65\u9aa4\u5217\u8868\u3002\u4f60\u53ef\u4ee5\u5728 Flow Studio \u91cc\u7ee7\u7eed\u4fee\u6539\uff0c\u4e4b\u540e\u518d\u91cd\u653e\u3002",
                )}
              </p>
            </details>
            <details className="help-faq-item">
              <summary>{pickUiText(locale, "What is an API token?", "\u4ec0\u4e48\u662f API token\uff1f")}</summary>
              <p>
                {pickUiText(
                  locale,
                  "This is the lab access credential for the backend. You only need it when backend authentication is enabled.",
                  "\u8fd9\u662f backend \u7684\u5b9e\u9a8c\u8bbf\u95ee\u51ed\u8bc1\u3002\u53ea\u6709\u5728 backend \u5f00\u542f\u8ba4\u8bc1\u65f6\u624d\u9700\u8981\u586b\u5199\u3002",
                )}
              </p>
            </details>
          </div>

          <div className="help-section">
            <h3>{pickUiText(locale, "Other", "\u5176\u4ed6")}</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRestartTour}
              data-testid="helptour-restart-onboarding"
            >
              {pickUiText(locale, "Restart stress-lab guide", "\u91cd\u65b0\u5f00\u59cb stress-lab \u5f15\u5bfc")}
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

export default memo(HelpPanel);
