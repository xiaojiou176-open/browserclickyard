import type { Task } from "./types";

export function isCancelableStatus(status: Task["status"]): boolean {
  return status === "queued" || status === "running";
}
