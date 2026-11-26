export function getBuildVersion(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA?.trim() || "development";
}
