export type Command = {
  command_id: string;
  title: string;
  description: string;
  tags: string[];
};

export type Task = {
  task_id: string;
  command_id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  requested_by: string | null;
  attempt: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  message: string | null;
  output_tail: string;
};

export type CommandState = "loading" | "error" | "empty" | "success";
export type TaskState = "loading" | "error" | "empty" | "success";
export type ActionState = "idle" | "success" | "error";

export type CommandCategory =
  | "init"
  | "pipeline"
  | "frontend"
  | "automation"
  | "maintenance"
  | "backend";
export type LogLevel = "info" | "success" | "warn" | "error";
export type LogEntry = {
  id: string;
  ts: string;
  level: LogLevel;
  message: string;
  commandId?: string;
};
export type UiNotice = { id: string; level: LogLevel; message: string };
export type FetchTaskOptions = { background?: boolean };

export type DiagnosticsPayload = {
  uptime_seconds: number;
  task_total: number;
  task_counts: Record<string, number>;
  metrics: { requests_total: number; rate_limited: number };
};

export type AlertsPayload = {
  state: "ok" | "degraded";
  failure_rate: number;
  threshold: number;
  completed: number;
  failed: number;
};

export type FlowPreviewStep = {
  step_id: string;
  action: string;
  url?: string | null;
  value_ref?: string | null;
  selector?: string | null;
};

export type FlowPreviewPayload = {
  session_id: string | null;
  start_url: string | null;
  generated_at: string | null;
  source_event_count: number;
  step_count: number;
  steps: FlowPreviewStep[];
};

export type FlowDraftDocumentPayload = {
  session_id: string | null;
  flow: Record<string, unknown> | null;
};

export type ReconstructionArtifactsPayload = {
  session_dir?: string;
  video_path?: string;
  har_path?: string;
  html_path?: string;
  html_content?: string;
};

export type ReconstructionPreviewPayload = {
  preview_id: string;
  flow_draft: Record<string, unknown>;
  reconstructed_flow_quality: number;
  step_confidence: number[];
  unresolved_segments: string[];
  manual_handoff_required: boolean;
  unsupported_reason: string | null;
  generator_outputs: Record<string, string>;
};

export type ReconstructionGeneratePayload = {
  flow_id: string;
  template_id: string;
  run_id: string | null;
  generator_outputs: Record<string, string>;
  reconstructed_flow_quality: number;
  step_confidence: number[];
  unresolved_segments: string[];
  manual_handoff_required: boolean;
  unsupported_reason: string | null;
};

export type ProfileResolvePayload = {
  profile: string;
  video_signals: string[];
  dom_alignment_score: number;
  har_alignment_score: number;
  recommended_manual_checkpoints: string[];
  manual_handoff_required: boolean;
  unsupported_reason: string | null;
};

export type FlowSelectorCandidate = {
  kind: "role" | "css" | "id" | "name";
  value: string;
  score: number;
};

export type FlowEditableStep = {
  step_id: string;
  action: "navigate" | "click" | "type" | string;
  url?: string;
  value_ref?: string;
  selected_selector_index?: number;
  target?: {
    selectors?: FlowSelectorCandidate[];
  };
};

export type FlowEditableDraft = {
  flow_id?: string;
  session_id?: string;
  start_url: string;
  generated_at?: string;
  source_event_count?: number;
  steps: FlowEditableStep[];
};

export type StepEvidencePayload = {
  step_id: string;
  action: string | null;
  ok: boolean | null;
  detail: string | null;
  duration_ms: number | null;
  matched_selector: string | null;
  selector_index: number | null;
  screenshot_before_path: string | null;
  screenshot_after_path: string | null;
  screenshot_before_data_url: string | null;
  screenshot_after_data_url: string | null;
  fallback_trail: Array<{
    selector_index: number;
    kind: string;
    value: string;
    normalized: string | null;
    success: boolean;
    error: string | null;
  }>;
};

export type EvidenceTimelineItem = {
  step_id: string;
  action: string | null;
  ok: boolean | null;
  detail: string | null;
  duration_ms: number | null;
  matched_selector: string | null;
  selector_index: number | null;
  screenshot_before_path: string | null;
  screenshot_after_path: string | null;
  screenshot_before_data_url: string | null;
  screenshot_after_data_url: string | null;
  fallback_trail: Array<{
    selector_index: number;
    kind: string;
    value: string;
    normalized: string | null;
    success: boolean;
    error: string | null;
  }>;
};

export type EvidenceTimelinePayload = {
  items: EvidenceTimelineItem[];
};

export type UniversalSession = {
  session_id: string;
  start_url: string;
  mode: "manual" | "ai";
  owner: string | null;
  started_at: string;
  finished_at: string | null;
  artifacts_index: Record<string, string>;
};

export type UniversalFlow = {
  flow_id: string;
  session_id: string;
  version: number;
  quality_score: number;
  start_url: string;
  source_event_count: number;
  steps: FlowEditableStep[];
  created_at: string;
  updated_at: string;
};

export type UniversalTemplate = {
  template_id: string;
  template_family_id?: string | null;
  parent_template_id?: string | null;
  flow_id: string;
  version?: number;
  status?: "draft" | "active" | "superseded" | "archived";
  name: string;
  params_schema: Array<{
    key: string;
    type: "string" | "secret" | "enum" | "regex" | "email";
    required: boolean;
    description?: string | null;
    enum_values?: string[];
    pattern?: string | null;
  }>;
  defaults: Record<string, string>;
  policies: {
    retries: number;
    timeout_seconds: number;
    otp: {
      required: boolean;
      provider: "manual" | "gmail" | "imap" | "vonage";
      timeout_seconds: number;
      regex: string;
      sender_filter?: string | null;
      subject_filter?: string | null;
    };
    branches: Record<string, unknown>;
  };
  recommended?: boolean;
  promotion_source?: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type UniversalRun = {
  run_id: string;
  template_id: string;
  status:
    | "queued"
    | "running"
    | "waiting_user"
    | "waiting_otp"
    | "success"
    | "failed"
    | "cancelled";
  wait_context?: {
    reason_code?: string | null;
    at_step_id?: string | null;
    after_step_id?: string | null;
    resume_from_step_id?: string | null;
    resume_hint?: string | null;
    provider_domain?: string | null;
    gate_required_by_policy?: boolean | null;
    screen_title?: string | null;
    allowed_resume_kinds?: Array<"otp" | "approval" | "input" | "checkpoint_ack">;
    input_schema?: Array<{
      name: string;
      label: string;
      kind: "otp" | "text" | "textarea" | "ack";
      required?: boolean;
      placeholder?: string | null;
      help_text?: string | null;
    }>;
    required_actions?: Array<{
      kind: "otp" | "approval" | "input" | "checkpoint_ack";
      label: string;
      description?: string | null;
    }>;
    evidence_refs?: string[];
  } | null;
  step_cursor: number;
  params: Record<string, string>;
  task_id: string | null;
  last_error: string | null;
  artifacts_ref: Record<string, string>;
  created_at: string;
  updated_at: string;
  logs: Array<{ ts: string; level: "info" | "warn" | "error"; message: string }>;
};

export type ProofCampaign = {
  campaign_id: string;
  model: string;
  name?: string | null;
  description?: string | null;
  status: "passed" | "failed" | "blocked";
  policy_mode: string;
  run_ids: string[];
  reason_codes: string[];
  created_at: string;
  updated_at: string;
  report_path: string;
  index_path: string;
};

export type ProofCampaignDetail = {
  campaign: ProofCampaign;
  report: Record<string, unknown>;
};

export type RunCompareResult = {
  left_run_id: string;
  right_run_id: string;
  left_gate_status?: string | null;
  right_gate_status?: string | null;
  metrics_delta: {
    values: Record<string, number | null>;
  };
  checks: {
    added_failed_or_blocked: string[];
    removed_failed_or_blocked: string[];
    persisted_failed_or_blocked: string[];
  };
  summary: Record<string, unknown>;
};

export type RunAiReviewProjection = {
  run_id: string;
  enabled: boolean;
  report_path?: string | null;
  markdown_path?: string | null;
  findings: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
  generation: Record<string, unknown>;
};

export type ReleaseBrief = {
  run_id: string;
  baseline_run_id?: string | null;
  recommendation: string;
  gate_status?: string | null;
  observed: Record<string, unknown>;
  ai_interpretation: Record<string, unknown>;
  evidence_snapshot: Record<string, unknown>;
  open_questions: string[];
  next_step: string;
};

export type SimilarFailureMatch = {
  run_id: string;
  score: number;
  gate_status?: string | null;
  reason_codes: string[];
  summary: Record<string, unknown>;
  why_matched: string;
  report_path?: string | null;
};

export type SimilarFailuresResult = {
  run_id: string;
  matches: SimilarFailureMatch[];
};

export type TargetFeasibility = {
  template_id: string;
  target: string;
  supported: boolean;
  blocked_reasons: string[];
  migration_hints: string[];
  required_capabilities: string[];
};

export type RunRecordSource = "command" | "template";

export type RunRecordDetailSection =
  | "source"
  | "lane"
  | "status"
  | "progress"
  | "timeline"
  | "output";

export type RunRecordViewHint = {
  title: "Run record details" | "Run details";
  sections: RunRecordDetailSection[];
};

// UI label mappings keep the protocol fields unchanged while presenting
// beginner-friendly product copy.
export const RUN_RECORD_SOURCE_LABEL: Record<RunRecordSource, string> = {
  command: "Command run",
  template: "Template run",
};

export const RUN_RECORD_DETAIL_SECTION_LABEL: Record<RunRecordDetailSection, string> = {
  source: "Source",
  lane: "Lane",
  status: "Status",
  progress: "Progress",
  timeline: "Timeline",
  output: "Output",
};

export const UNIVERSAL_RUN_STATUS_LABEL: Record<UniversalRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  waiting_user: "Waiting for user input",
  waiting_otp: "Waiting for OTP",
  success: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};
