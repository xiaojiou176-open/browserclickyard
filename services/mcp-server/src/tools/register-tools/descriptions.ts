// @ts-nocheck
// 
export const CORE_TOOL_DESCRIPTIONS = {
  backendRuntime: `Goal:
- Manage MCP-owned backend runtime lifecycle and health state.
Use When:
- Backend is not ready before orchestration or API calls.
Required Inputs:
- action: start | status | stop.
- preferredPort: optional when action=start.
Call Order:
- 1) start 2) status (optional check) 3) stop when cleanup is needed.
Success Output:
- { ok: runtime.ok, action, runtime } with pid/baseUrl/health fields.
If Failed:
- Read detail, then retry start or inspect backend logs and runtime files.
Do Not:
- Do not call stop unless you want to terminate the managed backend runtime.`,
  apiSessions: `Goal:
- Operate session lifecycle through one endpoint wrapper.
Use When:
- Need to list sessions, start a capture session, or finish a session.
Required Inputs:
- action: list | start | finish.
- start requires startUrl; finish requires sessionId.
Call Order:
- 1) start (or list existing) 2) use session_id downstream 3) finish when done.
Success Output:
- { ok: true, action, payload } where payload is a session list or session object.
If Failed:
- Error detail explains missing inputs or services/api/API failures.
Do Not:
- Do not call finish without a valid sessionId.`,
  registerOrchestrate: `Goal:
- Execute the register closed-loop flow: prepare | teach | clone | resume.
Use When:
- Need end-to-end onboarding/register automation with template and run lifecycle control.
Required Inputs:
- action is required; other fields depend on action.
- teach requires startUrl; clone requires templateId; resume requires runId.
Call Order:
- 1) prepare -> 2) teach -> 3) clone -> 4) resume (OTP or continuation).
Success Output:
- Returns action-specific objects with runtime plus created/imported run/template data.
If Failed:
- detail explains validation, API, or polling errors; waiting_otp may require otpCode plus resume.
Do Not:
- Do not skip required fields for the selected action.`,
  registerState: `Goal:
- Read a compact state snapshot of runtime, session, flow, template, and run entities.
Use When:
- Need current closed-loop progress or post-run state inspection.
Required Inputs:
- All inputs are optional; provide IDs to pin exact entities.
Call Order:
- Usually after prepare, teach, clone, or resume to confirm the latest state.
Success Output:
- { ok: true, runtime, session, flow, template, run }.
If Failed:
- detail contains the services/api/API retrieval error reason.
Do Not:
- Do not treat null as an error when an entity is absent or an ID was not provided.`,
  apiFlows: `Goal:
- Provide one flows wrapper for list, get, import_latest, create, and update.
Use When:
- Need to manage flow records around session teaching, import, or update steps.
Required Inputs:
- action is required; flowId is required for get/update.
- create requires sessionId + startUrl.
- update requires flowId and at least one mutable field (startUrl/steps).
Call Order:
- Common path: import_latest or create -> get -> update if needed.
Success Output:
- Returns the raw backend payload in MCP text content while preserving API fields.
If Failed:
- Throws clear missing-input errors or returns an API error payload with isError.
Do Not:
- Do not call get or update without flowId.`,
  apiTemplates: `Goal:
- Provide one templates wrapper for list, get, export, create, and update.
Use When:
- Need to build or maintain reusable automation template definitions.
Required Inputs:
- action is required; templateId is required for get/export/update.
- create requires flowId + name.
- update requires templateId and at least one mutable field (name/paramsSchema/defaults/policies).
Call Order:
- Typical path: create -> get/export -> update (or list first for discovery).
Success Output:
- Returns the backend template payload without reshaping its structure.
If Failed:
- Missing required IDs raise explicit errors; API failures return isError.
Do Not:
- Do not use update, export, or get without templateId.`,
  apiRuns: `Goal:
- Provide one runs wrapper for list, get, create, otp, and cancel.
Use When:
- Need to create and monitor execution runs, submit OTP, or cancel a run.
Required Inputs:
- action is required; runId is required for get/otp/cancel.
- create requires templateId.
- otp requires runId + otpCode.
Call Order:
- Normal path: create -> get/list polling -> otp only when status is waiting_otp -> cancel only if needed.
Success Output:
- Returns the backend run payload with compatible fields for orchestration.
If Failed:
- Missing runId or action mismatch errors are explicit; API failures set isError.
Do Not:
- Do not call otp, cancel, or get without runId.`,
} as const;

export const RUN_TOOL_DESCRIPTIONS = {
  computerUseRun: `Goal:
- Execute the CLI computer-use command through a constrained MCP entrypoint.
Use When:
- Need AI computer-use execution with task text plus optional step and speed controls.
Required Inputs:
- task is required; maxSteps, speedMode, and runId are optional.
Call Order:
- 1) call with task -> 2) inspect runId/stdout/stderr -> 3) follow up with run artifact tools if needed.
Success Output:
- Same run result envelope as uiq_run_command/uiq_run_profile (ok/detail/stdout/stderr/runId/manifest/exitCode).
If Failed:
- Returns command failure detail (for example invalid task or runId) with isError=true.
Do Not:
- Do not pass unrelated command flags; this tool only controls computer-use options.`,
} as const;
