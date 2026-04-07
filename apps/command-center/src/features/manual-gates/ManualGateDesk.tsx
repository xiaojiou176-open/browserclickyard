import { Card, CardContent, CardHeader, CardTitle, Button } from "../../components/ui";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../../i18n/uiLocale";
import type { UniversalRun } from "../../types";

type ManualGateDeskProps = {
  run: UniversalRun;
  locale?: UiLocale;
  otpCode: string;
  otpValidationError: string | null;
  canSubmitWaitingInput: boolean;
  onOtpCodeChange: (code: string) => void;
  onSubmit: (runId: string, status: UniversalRun["status"], waitContext?: UniversalRun["wait_context"]) => void;
};

function getInputCopy(run: UniversalRun, locale: UiLocale): {
  title: string;
  hint: string;
  placeholder: string;
  buttonLabel: string;
  buttonDescription: string;
} {
  const context = run.wait_context;
  const kinds = context?.allowed_resume_kinds ?? [];
  const isProviderProtected = context?.reason_code === "provider_protected_payment_step";
  if (run.status === "waiting_otp") {
    return {
      title:
        context?.screen_title ||
        pickUiText(locale, "OTP required before resume", "恢复前需要先输入 OTP"),
      hint:
        context?.resume_hint ||
        pickUiText(
          locale,
          "This workflow run is paused and waiting for a one-time code before it can continue.",
          "这条工作流运行已暂停，正在等待一次性验证码后才能继续。",
        ),
      placeholder: pickUiText(locale, "Enter 4-8 digit OTP", "输入 4-8 位 OTP"),
      buttonLabel: pickUiText(locale, "Send OTP and resume", "发送 OTP 并继续"),
      buttonDescription:
        pickUiText(
          locale,
          "This sends the code to the paused workflow run and asks it to continue from the saved checkpoint.",
          "这会把验证码发送给暂停中的工作流运行，并要求它从已保存的检查点继续。",
        ),
    };
  }
  if (isProviderProtected || kinds.includes("approval")) {
    return {
      title:
        context?.screen_title ||
        pickUiText(locale, "Manual check required before resume", "恢复前需要人工检查"),
      hint:
        context?.resume_hint ||
        pickUiText(
          locale,
          "This workflow run is paused on a protected provider step. Finish the check in the opened page, then resume from here.",
          "这条工作流运行暂停在受保护的 provider 步骤。请先在打开的页面完成检查，再回到这里恢复。",
        ),
      placeholder: pickUiText(locale, "Add an optional operator note", "填写可选的操作员备注"),
      buttonLabel: pickUiText(locale, "Resume after manual check", "人工检查后继续"),
      buttonDescription:
        pickUiText(
          locale,
          "This records approval for the current manual gate and asks the workflow run to continue from the saved checkpoint.",
          "这会记录当前人工闸门的确认结果，并要求工作流运行从已保存的检查点继续。",
        ),
    };
  }
  return {
    title:
      context?.screen_title ||
      pickUiText(locale, "Input required before resume", "恢复前需要补充输入"),
    hint:
      context?.resume_hint ||
      pickUiText(
        locale,
        "This workflow run is paused and waiting for additional input before it can continue.",
        "这条工作流运行已暂停，正在等待补充输入后才能继续。",
      ),
    placeholder: pickUiText(locale, "Enter the requested input", "输入所需内容"),
    buttonLabel: pickUiText(locale, "Send input and resume", "发送输入并继续"),
    buttonDescription:
      pickUiText(
        locale,
        "This sends the requested input to the paused workflow run and asks it to continue from the saved checkpoint.",
        "这会把所需输入发送给暂停中的工作流运行，并要求它从已保存的检查点继续。",
      ),
  };
}

function buildCopilotGuidance(run: UniversalRun, locale: UiLocale): {
  label: string;
  nextStep: string;
  checklist: string[];
  caution: string;
} {
  const context = run.wait_context;
  const kinds = context?.allowed_resume_kinds ?? [];
  const stepLabel =
    context?.resume_from_step_id ||
    context?.at_step_id ||
    context?.after_step_id ||
    pickUiText(locale, "the paused checkpoint", "当前暂停检查点");
  if (run.status === "waiting_otp") {
    return {
      label: pickUiText(locale, "Resume Guide", "恢复指南"),
      nextStep: pickUiText(
        locale,
        `Collect the one-time code, confirm it matches this paused run, then resume from ${stepLabel}.`,
        `先拿到一次性验证码，确认它属于这次暂停中的运行，再从 ${stepLabel} 继续。`,
      ),
      checklist: [
        pickUiText(
          locale,
          "Verify the code belongs to the current run or provider challenge.",
          "确认这串验证码属于当前运行或对应的 provider challenge。",
        ),
        pickUiText(locale, "Enter the 4-8 digit code exactly as received.", "按收到的原样输入 4-8 位验证码。"),
        pickUiText(
          locale,
          "Resume only after the code is ready; do not guess placeholders.",
          "只有验证码准备好后再继续；不要猜测占位内容。",
        ),
      ],
      caution:
        pickUiText(
          locale,
          "OTP resume is an operator-confirmed step. The system will not continue until a human supplies the code.",
          "OTP 恢复属于人工确认步骤。在人类提供验证码之前，系统不会继续。",
        ),
    };
  }
  if (context?.reason_code === "provider_protected_payment_step" || kinds.includes("approval")) {
    return {
      label: pickUiText(locale, "Manual Gate Copilot", "人工闸门助手"),
      nextStep: pickUiText(
        locale,
        `Finish the provider check outside the app, then resume this run from ${stepLabel}.`,
        `先在应用外完成 provider 检查，再让这次运行从 ${stepLabel} 继续。`,
      ),
      checklist: [
        pickUiText(
          locale,
          "Confirm the provider challenge page is the one opened for this run.",
          "确认当前 provider challenge 页面就是为这次运行打开的页面。",
        ),
        pickUiText(
          locale,
          "Finish the external approval or challenge before clicking resume.",
          "点击继续前，先完成外部审批或挑战步骤。",
        ),
        pickUiText(
          locale,
          "Add a short operator note if future reviewers need context.",
          "如果后续复核需要上下文，请补一条简短的操作员备注。",
        ),
      ],
      caution:
        pickUiText(
          locale,
          "Approval stays human-owned. This guide can explain the pause, but it does not approve on your behalf.",
          "审批责任仍然归人类所有。这个助手只负责解释暂停原因，不会替你批准。",
        ),
    };
  }
  return {
    label: pickUiText(locale, "Manual Gate Copilot", "人工闸门助手"),
    nextStep: pickUiText(
      locale,
      `Prepare the requested supplemental input, then resume the workflow from ${stepLabel}.`,
      `先准备好请求的补充输入，再让工作流从 ${stepLabel} 继续。`,
    ),
    checklist: [
      pickUiText(
        locale,
        "Check the screen title and resume hint for the exact missing input.",
        "先查看屏幕标题和恢复提示，确认到底缺什么输入。",
      ),
      pickUiText(
        locale,
        "Confirm whether the requested field is required before submitting.",
        "提交前确认这个字段是否必填。",
      ),
      pickUiText(
        locale,
        "Resume only after the input is complete and belongs to this run.",
        "只有输入完整且属于这次运行时再继续。",
      ),
    ],
    caution:
      pickUiText(
        locale,
        "This guidance is a helper layer over the existing wait context. The source of truth remains the paused run and its evidence.",
        "这层指引只是建立在现有 wait context 之上的辅助说明。真正的真相来源仍是暂停中的运行及其证据。",
      ),
  };
}

export default function ManualGateDesk({
  run,
  locale = DEFAULT_UI_LOCALE,
  otpCode,
  otpValidationError,
  canSubmitWaitingInput,
  onOtpCodeChange,
  onSubmit,
}: ManualGateDeskProps) {
  const copy = getInputCopy(run, locale);
  const copilot = buildCopilotGuidance(run, locale);
  const inputSchema = run.wait_context?.input_schema ?? [];
  const isProviderProtected =
    run.wait_context?.reason_code === "provider_protected_payment_step";
  const pauseStepId =
    run.wait_context?.at_step_id ??
    run.wait_context?.resume_from_step_id ??
    run.wait_context?.after_step_id ??
    null;
  const resumeStepId =
    run.wait_context?.resume_from_step_id ?? run.wait_context?.after_step_id ?? null;
  const providerDomain = run.wait_context?.provider_domain ?? null;
  const shouldRenderInput =
    !isProviderProtected &&
    (run.status === "waiting_otp" || run.status === "waiting_user" || inputSchema.length > 0);
  const pauseSummary = pauseStepId
    ? pickUiText(
        locale,
        `Paused at step ${pauseStepId}${providerDomain ? ` on ${providerDomain}` : ""}.`,
        `当前暂停在步骤 ${pauseStepId}${providerDomain ? `（${providerDomain}）` : ""}。`,
      )
    : providerDomain
      ? pickUiText(locale, `Paused on ${providerDomain}.`, `当前暂停在 ${providerDomain}。`)
      : pickUiText(
          locale,
          "The workflow run is paused and waiting for operator help.",
          "这条工作流运行已暂停，正在等待人工协助。",
        );
  const buttonSummary = resumeStepId
    ? pickUiText(
        locale,
        `${copy.buttonDescription} Resume will continue from step ${resumeStepId}.`,
        `${copy.buttonDescription} 恢复后会从步骤 ${resumeStepId} 继续。`,
      )
    : copy.buttonDescription;

  return (
    <Card
      className="card-raised mt-3 p-3"
      aria-label={pickUiText(locale, "Manual gate desk", "人工闸门工作台")}
    >
      <CardHeader>
        <CardTitle>
          {pickUiText(locale, copy.title, `\u4eba\u5de5\u95f8\u95e8\uff1a${copy.title}`)}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="hint-text">{pauseSummary}</p>
        <p className="hint-text mt-2">{copy.hint}</p>
        <p className="hint-text mt-2">{buttonSummary}</p>
        <div className="mt-3">
          <p className="field-label">
            {pickUiText(locale, copilot.label, "\u4eba\u5de5\u95f8\u95e8\u52a9\u624b")}
          </p>
          <p className="hint-text mt-2">{copilot.nextStep}</p>
          <ul
            className="task-list mt-2"
            aria-label={pickUiText(locale, "Manual gate copilot checklist", "人工闸门助手检查清单")}
          >
            {copilot.checklist.map((item) => (
              <li key={item} className="task-item">
                <div className="task-item-info text-left">
                  <p>{item}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="hint-text mt-2">{copilot.caution}</p>
        </div>
        {run.wait_context?.required_actions && run.wait_context.required_actions.length > 0 && (
          <p className="hint-text mt-2">
            {pickUiText(
              locale,
              `Accepted responses here: ${run.wait_context.required_actions.map((item) => item.label).join(", ")}`,
              `这里接受的响应有：${run.wait_context.required_actions.map((item) => item.label).join("，")}`,
            )}
          </p>
        )}
        {isProviderProtected ? (
          <div className="form-actions mt-2">
            <Button size="sm" onClick={() => onSubmit(run.run_id, run.status, run.wait_context)}>
              {pickUiText(locale, copy.buttonLabel, `\u7ee7\u7eed\uff1a${copy.buttonLabel}`)}
            </Button>
          </div>
        ) : null}
        {shouldRenderInput && (
          <div className="field-row mt-2">
            <label className="sr-only" htmlFor="run-waiting-input">
              {run.status === "waiting_otp"
                ? pickUiText(locale, "OTP input", "OTP 输入")
                : pickUiText(locale, "Supplemental input", "补充输入")}
            </label>
            <input
              id="run-waiting-input"
              className="field-input"
              type="text"
              inputMode={run.status === "waiting_otp" ? "numeric" : "text"}
              pattern={run.status === "waiting_otp" ? "[0-9]{4,8}" : undefined}
              minLength={run.status === "waiting_otp" ? 4 : undefined}
              maxLength={run.status === "waiting_otp" ? 8 : undefined}
              placeholder={copy.placeholder}
              value={otpCode}
              onChange={(event) => onOtpCodeChange(event.target.value)}
              aria-invalid={otpValidationError ? "true" : undefined}
              aria-describedby={otpValidationError ? "manual-gate-input-error" : undefined}
            />
            <Button
              size="sm"
              onClick={() => onSubmit(run.run_id, run.status, run.wait_context)}
              disabled={!canSubmitWaitingInput}
            >
              {pickUiText(locale, copy.buttonLabel, `\u7ee7\u7eed\uff1a${copy.buttonLabel}`)}
            </Button>
          </div>
        )}
        {otpValidationError && (
          <p
            id="manual-gate-input-error"
            className="error-text mt-2"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {otpValidationError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
