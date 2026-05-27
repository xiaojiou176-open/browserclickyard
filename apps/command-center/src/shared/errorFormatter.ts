const STRUCTURED_ERROR_TOKENS = ["Conclusion:", "Action:", "Troubleshooting entry:"] as const;

export interface ActionableErrorFormatOptions {
  action: string;
  troubleshootingEntry: string;
}

export const formatActionableErrorMessage = (
  message: string,
  options: ActionableErrorFormatOptions,
): string => {
  const normalized = message.trim();
  if (!normalized) {
    return "";
  }
  if (STRUCTURED_ERROR_TOKENS.every((token) => normalized.includes(token))) {
    return normalized;
  }
  return `Conclusion: ${normalized}. Action: ${options.action}. Troubleshooting entry: ${options.troubleshootingEntry}`;
};
