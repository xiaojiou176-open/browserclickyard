/* @vitest-environment jsdom */

import type { ComponentProps } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UniversalTemplate } from "../types";
import QuickLaunchView from "./QuickLaunchView";

const LANE_MAP_SUMMARY =
  "Start with a target URL in Stress Lab, choose the kind of browser experiment you want to run, inspect the latest result in Runs & Blocks, and open Advanced Review only when you need deeper governed comparison.";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

vi.mock("../components/CommandGrid", () => ({
  default: () => null,
}));

vi.mock("../components/ParamsPanel", () => ({
  default: () => null,
}));

vi.mock("../components/EmptyState", () => ({
  default: () => null,
}));

const baseTemplate: UniversalTemplate = {
  template_id: "tpl-1",
  flow_id: "flow-abcdef123456",
  name: "Sample template",
  params_schema: [{ key: "email", type: "email", required: true }],
  defaults: { email: "demo@example.com" },
  policies: {
    retries: 0,
    timeout_seconds: 120,
    otp: {
      required: true,
      provider: "manual",
      timeout_seconds: 120,
      regex: "\\b(\\d{6})\\b",
      sender_filter: "",
      subject_filter: "",
    },
    branches: {},
  },
  created_by: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function getButtonAttributes(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matched = html.match(new RegExp(`<button([^>]*)>\\s*${escaped}\\s*</button>`));
  return matched?.[1] ?? "";
}

function renderFirstUseView(overrides?: Partial<ComponentProps<typeof QuickLaunchView>>) {
  const { container } = render(
    <QuickLaunchView
      commands={[]}
      commandState="success"
      activeTab="all"
      submittingId=""
      feedbackText=""
      onActiveTabChange={() => {}}
      onRunCommand={() => {}}
      params={{
        baseUrl: "http://127.0.0.1:17380",
        startUrl: "",
        successSelector: "#ok",
        modelName: "models/gemini-3.1-pro-preview",
        registerPassword: "",
        automationToken: "",
        automationClientId: "client-001",
        headless: false,
        midsceneStrict: false,
      }}
      onParamsChange={() => {}}
      templates={[]}
      templateHistory={[]}
      onCreateRun={() => {}}
      onForkTemplateVersion={() => {}}
      onMarkTemplateRecommended={() => {}}
      onRunParamsChange={() => {}}
      runParams={{}}
      onSelectedTemplateIdChange={() => {}}
      selectedTemplateId=""
      isFirstUseActive
      firstUseStage="configure"
      firstUseProgress={{ configValid: false, runTriggered: false, resultSeen: false }}
      canCompleteFirstUse={false}
      onFirstUseStageChange={() => {}}
      onCompleteFirstUse={() => {}}
      {...overrides}
    />,
  );
  return container.innerHTML;
}

describe("QuickLaunchView first-use guard rails", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        media: "(max-width: 1024px)",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables "continue to run" before config becomes valid', () => {
    const html = renderFirstUseView();
    const text = html.replace(/&amp;/g, "&");
    expect(text).toContain(LANE_MAP_SUMMARY);
    expect(text).toContain(RECOMMENDED_FIRST_PATH);
    expect(text).toContain(
      "Please enter a valid baseUrl / startUrl (startUrl is optional) and configure successSelector.",
    );
    expect(getButtonAttributes(html, "Configuration complete, continue to run")).toContain("disabled");
  });

  it("disables completion when result is not visible yet", () => {
    const html = renderFirstUseView({
      firstUseStage: "verify",
      firstUseProgress: { configValid: true, runTriggered: true, resultSeen: false },
      canCompleteFirstUse: false,
    });
    const text = html.replace(/&amp;/g, "&");
    expect(text).toContain(
      "A success or failure result has not been detected yet. Wait in Runs & Blocks before completing the guide.",
    );
    expect(getButtonAttributes(html, "Complete first-run guide")).toContain("disabled");
  });

  it("renders template copy in English without raw engineering jargon", () => {
    const html = renderFirstUseView({
      firstUseStage: "run",
      firstUseProgress: { configValid: true, runTriggered: false, resultSeen: false },
      templates: [baseTemplate],
      selectedTemplateId: baseTemplate.template_id,
      runParams: { email: "demo@example.com" },
    });
    expect(html).toContain("Flow template:");
    expect(html).toContain("OTP");
    expect(html).toContain("Start run");
    expect(html).toContain("Check target fit");
    expect(html).toContain('for="template-tpl-1-email"');
    expect(html).toContain('id="template-tpl-1-email"');
  });

  it("renders the first-use guidance in Chinese when locale is zh-CN", () => {
    const html = renderFirstUseView({
      locale: "zh-CN",
      firstUseStage: "configure",
      firstUseProgress: { configValid: false, runTriggered: false, resultSeen: false },
    });
    const text = html.replace(/&amp;/g, "&");

    expect(text).toContain("\u9996\u6b21\u5f15\u5bfc");
    expect(text).toContain("\u63a8\u8350\u8def\u5f84\uff1a\u5148\u586b URL");
    expect(text).toContain("\u6b65\u9aa4 1\uff1a\u914d\u7f6e\u76ee\u6807 URL");
    expect(text).toContain("\u8bf7\u8f93\u5165\u6709\u6548\u7684 baseUrl / startUrl");
  });
});
