import type { DoctorStatus } from "./types.js";

function worst(statuses: DoctorStatus[]): DoctorStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

function isErrnoException(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

export { worst, isErrnoException };
