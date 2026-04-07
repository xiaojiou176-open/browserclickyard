/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ParamsPanel, { defaultStartUrlRoutePath, type ParamsState } from "./ParamsPanel";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readRegisterRoutePathFromContract(): string {
  const contractPath = resolve(__dirname, "../../../../configs/states/routes.yaml");
  const contractText = readFileSync(contractPath, "utf8");
  const registerRouteBlockMatch = contractText.match(
    /- id:\s*route_register[\s\S]*?path:\s*(\/\S+)/,
  );
  if (!registerRouteBlockMatch || !registerRouteBlockMatch[1]) {
    throw new Error("route_register.path is missing in configs/states/routes.yaml");
  }
  return registerRouteBlockMatch[1];
}

function createDefaultParams(): ParamsState {
  return {
    baseUrl: "",
    startUrl: "",
    successSelector: "",
    modelName: "",
    registerPassword: "",
    automationToken: "",
    automationClientId: "",
    headless: true,
    midsceneStrict: false,
  };
}

describe("ParamsPanel start-url contract alignment", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("keeps start-url placeholder consistent with routes contract", () => {
    const registerRoutePath = readRegisterRoutePathFromContract();
    expect(defaultStartUrlRoutePath).toBe(registerRoutePath);

    act(() => {
      root.render(<ParamsPanel params={createDefaultParams()} onChange={() => {}} />);
    });

    const input = container.querySelector<HTMLInputElement>("#start-url");
    expect(input?.placeholder).toBe(`Optional; defaults to the base URL plus ${registerRoutePath}`);
  });

  it("renders the params shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <ParamsPanel params={createDefaultParams()} locale="zh-CN" onChange={() => {}} />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("目标与实验设置");
    expect(text).toContain("待测试的 Web 应用 URL");
    expect(text).toContain("AI 辅助模型");
    expect(text).toContain("实验访问令牌");
  });
});
