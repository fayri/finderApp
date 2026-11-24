function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getApiErrorMessage(payload: unknown, fallback: string, status?: number): string {
  const response = isRecord(payload) ? payload : null;
  const nestedError = isRecord(response?.error) ? response.error : null;
  const validationDetails = Array.isArray(response?.detail)
    ? response.detail
        .filter(isRecord)
        .map((issue) => {
          const field = Array.isArray(issue.loc)
            ? issue.loc.filter((part): part is string => typeof part === "string" && part !== "body").join(".")
            : "";
          const reason = typeof issue.msg === "string" ? issue.msg.trim() : "The value is invalid.";
          return field ? `The matcher rejected the request field “${field}”: ${reason}` : reason;
        })
        .join("; ")
    : null;
  const candidates = [
    nestedError?.message,
    typeof response?.error === "string" ? response.error : null,
    validationDetails,
    response?.detail,
    response?.message,
  ];
  const message = candidates.find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()));

  if (message) {
    return typeof status === "number" ? `${message.trim()} (HTTP ${status})` : message.trim();
  }

  return typeof status === "number" ? `${fallback} (HTTP ${status})` : fallback;
}
