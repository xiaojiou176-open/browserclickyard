import path from "node:path";

export type SelectorCandidate = {
  kind: "role" | "css" | "id" | "name";
  value: string;
  score: number;
};

export type FlowStep = {
  step_id: string;
  action: "navigate" | "click" | "type" | string;
  url?: string;
  value_ref?: string;
  gate_policy?: "auto" | "force_manual" | "forbid_manual";
  gate_reason?: string;
  selected_selector_index?: number;
  target?: {
    selectors?: SelectorCandidate[];
  };
};

export type FlowDraft = {
  flow_id: string;
  session_id: string;
  start_url: string;
  steps: FlowStep[];
};

export type SelectorAttempt = {
  selector_index: number;
  kind: string;
  value: string;
  normalized: string | null;
  success: boolean;
  error: string | null;
};

export type ReplayStepResult = {
  step_id: string;
  action: string;
  ok: boolean;
  detail: string;
  manual_gate_required?: boolean;
  provider_domain: string | null;
  gate_required_by_policy: boolean;
  matched_selector: string | null;
  selector_index: number | null;
  duration_ms: number;
  screenshot_before_path: string | null;
  screenshot_after_path: string | null;
  fallback_trail: SelectorAttempt[];
};

export type StripeFieldKey =
  | "card_number"
  | "exp"
  | "exp_month"
  | "exp_year"
  | "cvc"
  | "postal_code"
  | "name";

export type ManualGateSignal = {
  required: boolean;
  reason: string | null;
  reason_code: string | null;
  at_step_id: string | null;
  after_step_id: string | null;
  resume_from_step_id: string | null;
  provider_domain: string | null;
  gate_required_by_policy: boolean;
  signals: string[];
  resume_hint: string | null;
};

export type OtpFetchAttempt = { code: string } | { code: null; transient: boolean; reason: string };

export type ResumeSessionSnapshot = {
  updated_at: string;
  current_url: string;
  last_step_id: string | null;
  status: "running" | "manual_gate" | "failed" | "success";
};

export const RUNTIME_ROOT = path.resolve(process.cwd(), "..", ".runtime-cache", "automation");
export const REPO_ROOT = path.resolve(process.cwd(), "..");
export const RESUME_STORAGE_STATE_FILE = "replay-resume-storage-state.json";
export const RESUME_SESSION_FILE = "replay-resume-session.json";
export const DEFAULT_PROTECTED_PROVIDER_DOMAINS = ["stripe.com", "js.stripe.com"];
export const PROVIDER_PROTECTED_PAYMENT_REASON = "provider_protected_payment_step";
