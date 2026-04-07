export type RoundNumber = 1 | 2 | 3;

export type Severity = "P0" | "P1" | "P2" | "NONE";

export type ApiRunStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_otp"
  | "success"
  | "failed"
  | "cancelled"
  | "blocked";

export type RunnerOutcome =
  | "ok"
  | "manual_gate"
  | "timeout"
  | "api_error"
  | "parse_error"
  | "synthetic_aggregate";

export type AttemptRecord = {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  status: ApiRunStatus;
  runnerOutcome: RunnerOutcome;
  reasonCode?: string;
  severity: Severity;
  retryUsed: boolean;
  rootCause: string;
  runId?: string;
  sessionId?: string;
  flowId?: string;
  templateId?: string;
  taskId?: string;
  stepCursor?: number;
  lastError?: string | null;
  logs: Array<{ ts: string; level: string; message: string }>;
};

export type SubjectResult = {
  subject: string;
  email: string;
  finalStatus: ApiRunStatus;
  runnerOutcome: RunnerOutcome;
  reasonCode?: string;
  severity: Severity;
  pass: boolean;
  rootCause: string;
  attempts: AttemptRecord[];
};

export type RoundRunsArtifact = {
  version: number;
  generatedAt: string;
  round: RoundNumber;
  resume: boolean;
  baseUrl: string;
  startUrl: string;
  otpProvider: string;
  pollTimeoutSeconds: number;
  retries: number;
  runMode: "mcp_tools";
  manualGatePending: boolean;
  manualGateRunIds: string[];
  summary: {
    pass: boolean;
    status: "PASS" | "FAIL" | "PAUSED";
    subjectCount: number;
    passedCount: number;
    failedCount: number;
    severityCounts: Record<string, number>;
  };
  subjects: SubjectResult[];
};
