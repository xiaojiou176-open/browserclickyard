/* @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_TAB_FLOW_DRAFT_TEST_ID,
  CONSOLE_TAB_QUICK_LAUNCH_TEST_ID,
  CONSOLE_TAB_TASK_CENTER_TEST_ID,
} from "../constants/testIds";
import ConsoleHeader from "./ConsoleHeader";

const LANE_MAP_SUMMARY =
  "Start with a target URL in Stress Lab, choose the kind of browser experiment you want to run, inspect the latest result in Runs & Blocks, and open Advanced Review only when you need deeper governed comparison.";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

function getButtonAttributesByTestId(html: string, testId: string) {
  const matched = html.match(new RegExp(`<button([^>]*)data-testid="${testId}"([^>]*)>`));
  if (!matched) {
    return "";
  }
  return `${matched[1]} ${matched[2]}`;
}

describe("ConsoleHeader tab semantics", () => {
  it("exposes tab roles and aria-controls with roving tabindex", () => {
    const { container } = render(
      <ConsoleHeader
        runningCount={1}
        successCount={2}
        failedCount={3}
        activeView="tasks"
        onViewChange={() => {}}
        onOpenHelp={() => {}}
        onRestartTour={() => {}}
      />,
    );
    const html = container.innerHTML;
    const text = container.textContent ?? "";

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Primary navigation"');

    const quickLaunchTabAttrs = getButtonAttributesByTestId(html, CONSOLE_TAB_QUICK_LAUNCH_TEST_ID);
    const taskCenterTabAttrs = getButtonAttributesByTestId(html, CONSOLE_TAB_TASK_CENTER_TEST_ID);
    const flowDraftTabAttrs = getButtonAttributesByTestId(html, CONSOLE_TAB_FLOW_DRAFT_TEST_ID);

    expect(quickLaunchTabAttrs).toContain('role="tab"');
    expect(quickLaunchTabAttrs).toContain('aria-controls="app-view-launch-panel"');
    expect(quickLaunchTabAttrs).toContain('tabindex="-1"');

    expect(taskCenterTabAttrs).toContain('role="tab"');
    expect(taskCenterTabAttrs).toContain('aria-selected="true"');
    expect(taskCenterTabAttrs).toContain('aria-controls="app-view-tasks-panel"');
    expect(taskCenterTabAttrs).toContain('tabindex="0"');

    expect(flowDraftTabAttrs).toContain('role="tab"');
    expect(flowDraftTabAttrs).toContain('aria-controls="app-view-workshop-panel"');
    expect(flowDraftTabAttrs).toContain('tabindex="-1"');
    expect(text).toContain(LANE_MAP_SUMMARY);
    expect(text).toContain(RECOMMENDED_FIRST_PATH);
  });

  it("switches the high-visibility shell copy into Chinese when locale is zh-CN", () => {
    const { container } = render(
      <ConsoleHeader
        runningCount={1}
        successCount={2}
        failedCount={3}
        activeView="launch"
        locale="zh-CN"
        onLocaleChange={() => {}}
        onViewChange={() => {}}
        onOpenHelp={() => {}}
        onRestartTour={() => {}}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("\u538b\u529b\u5b9e\u9a8c\u5ba4");
    expect(text).toContain("\u4ece URL \u5f00\u59cb");
    expect(text).toContain("\u63a8\u8350\u8def\u5f84\uff1a\u5148\u586b URL");
    expect(text).toContain("\u8fd0\u884c\u4e2d 1");
    expect(text).toContain("\u5df2\u6210\u529f 2");
    expect(text).toContain("\u5df2\u5931\u8d25 3");
  });
});
