import { memo, useState } from "react";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { Button } from "./ui";

export const defaultStartUrlRoutePath = "/register";

export interface ParamsState {
  baseUrl: string;
  startUrl: string;
  successSelector: string;
  modelName: string;
  geminiApiKey?: string;
  registerPassword: string;
  automationToken: string;
  automationClientId: string;
  headless: boolean;
  midsceneStrict: boolean;
}

interface ParamsPanelProps {
  params: ParamsState;
  locale?: UiLocale;
  onChange: (patch: Partial<ParamsState>) => void;
}

function ParamsPanel({ params, locale = DEFAULT_UI_LOCALE, onChange }: ParamsPanelProps) {
  const [showToken, setShowToken] = useState(false);
  const [showGeminiApiKey, setShowGeminiApiKey] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);

  return (
    <div className="form-section">
      <h3 className="form-section-title">
        {pickUiText(locale, "Target and lab settings", "目标与实验设置")}
      </h3>
      <p className="hint-text">
        {pickUiText(
          locale,
          "Start with the web app URL you want to test. Localhost and managed targets are the safest path today. Broader URLs are exploratory first and may still need governed target setup before you treat them as release-grade proof.",
          "先填写你要测试的 Web 应用 URL。当前最稳妥的路径仍然是 localhost 和受管目标。更宽泛的 URL 先按探索性目标对待，正式作为 release-grade proof 之前可能还需要治理化目标配置。",
        )}
      </p>
      <div className="field-group">
        <div className="field">
          <label className="field-label" htmlFor="base-url">
            {pickUiText(locale, "Web app URL to test (BASE_URL)", "待测试的 Web 应用 URL（BASE_URL）")}
          </label>
          <input
            id="base-url"
            className="field-input"
            type="url"
            value={params.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="start-url">
            {pickUiText(locale, "Start page override (START_URL)", "起始页面覆盖（START_URL）")}
          </label>
          <input
            id="start-url"
            className="field-input"
            type="url"
            value={params.startUrl}
            onChange={(e) => onChange({ startUrl: e.target.value })}
            placeholder={pickUiText(
              locale,
              `Optional; defaults to the base URL plus ${defaultStartUrlRoutePath}`,
              `可选；默认会使用 BASE_URL 加上 ${defaultStartUrlRoutePath}`,
            )}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="success-selector">
            {pickUiText(locale, "Success checkpoint (selector)", "成功检查点（selector）")}
          </label>
          <input
            id="success-selector"
            className="field-input"
            type="text"
            value={params.successSelector}
            onChange={(e) => onChange({ successSelector: e.target.value })}
            placeholder={pickUiText(
              locale,
              "Example: .success-message or #welcome",
              "例如：.success-message 或 #welcome",
            )}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="model-name">
            {pickUiText(locale, "AI helper model", "AI 辅助模型")}
          </label>
          <input
            id="model-name"
            className="field-input"
            type="text"
            value={params.modelName}
            onChange={(e) => onChange({ modelName: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="api-key">
            {pickUiText(locale, "Gemini API key (optional)", "Gemini API key（可选）")}
          </label>
          <div className="field-row">
            <input
              id="api-key"
              className="field-input"
              type={showGeminiApiKey ? "text" : "password"}
              autoComplete="off"
              value={params.geminiApiKey ?? ""}
              onChange={(e) => onChange({ geminiApiKey: e.target.value })}
              placeholder={pickUiText(
                locale,
                "Only fill this in when GEMINI_API_KEY is injected locally or in CI",
                "只有在本地或 CI 已注入 GEMINI_API_KEY 时才需要填写",
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="params-toggle-api-key-visibility"
              aria-controls="api-key"
              aria-pressed={showGeminiApiKey}
              onClick={() => setShowGeminiApiKey((v) => !v)}
            >
              {showGeminiApiKey
                ? pickUiText(locale, "Hide", "隐藏")
                : pickUiText(locale, "Show", "显示")}
            </Button>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="register-password">
            {pickUiText(locale, "Registration password (optional)", "注册密码（可选）")}
          </label>
          <div className="field-row">
            <input
              id="register-password"
              className="field-input"
              type={showRegisterPassword ? "text" : "password"}
              autoComplete="off"
              value={params.registerPassword}
              onChange={(e) => onChange({ registerPassword: e.target.value })}
              placeholder={pickUiText(
                locale,
                "Only fill this in when the target site requires a fixed registration password",
                "只有在目标站点要求固定注册密码时才需要填写",
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="params-toggle-register-password-visibility"
              aria-controls="register-password"
              aria-pressed={showRegisterPassword}
              onClick={() => setShowRegisterPassword((v) => !v)}
            >
              {showRegisterPassword
                ? pickUiText(locale, "Hide", "隐藏")
                : pickUiText(locale, "Show", "显示")}
            </Button>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="automation-token">
            {pickUiText(locale, "Lab access token (API token)", "实验访问令牌（API token）")}
          </label>
          <div className="field-row">
            <input
              id="automation-token"
              className="field-input"
              type={showToken ? "text" : "password"}
              autoComplete="off"
              value={params.automationToken}
              onChange={(e) => onChange({ automationToken: e.target.value })}
              placeholder={pickUiText(
                locale,
                "Only fill this in when backend authentication is enabled",
                "只有在 backend 开启认证时才需要填写",
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="params-toggle-token-visibility"
              aria-controls="automation-token"
              aria-pressed={showToken}
              onClick={() => setShowToken((v) => !v)}
            >
              {showToken
                ? pickUiText(locale, "Hide", "隐藏")
                : pickUiText(locale, "Show", "显示")}
            </Button>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="automation-client-id">
            {pickUiText(locale, "Client identifier (Client ID)", "客户端标识（Client ID）")}
          </label>
          <input
            id="automation-client-id"
            className="field-input"
            type="text"
            autoComplete="off"
            value={params.automationClientId}
            onChange={(e) => onChange({ automationClientId: e.target.value })}
            placeholder={pickUiText(
              locale,
              "Generated on first use; you can override it manually",
              "首次使用时自动生成；你也可以手动覆盖",
            )}
          />
        </div>
        <div className="switch-group">
          <label className="switch-label">
            <input
              type="checkbox"
              checked={params.headless}
              onChange={(e) => onChange({ headless: e.target.checked })}
              data-testid="params-toggle-headless"
            />
            {pickUiText(locale, "Run browser headlessly", "以无头模式运行浏览器")}
          </label>
          <label className="switch-label">
            <input
              type="checkbox"
              checked={params.midsceneStrict}
              onChange={(e) => onChange({ midsceneStrict: e.target.checked })}
              data-testid="params-toggle-midscene-strict"
            />
            {pickUiText(
              locale,
              "Use strict page element matching (Midscene Strict)",
              "使用严格页面元素匹配（Midscene Strict）",
            )}
          </label>
        </div>
      </div>
    </div>
  );
}

export default memo(ParamsPanel);
