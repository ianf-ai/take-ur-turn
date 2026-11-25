export type PreflightCheckName = "node-manifest" | "node-modules" | "tut-dist" | "worktree-consistency";
export type PreflightStatus = "ok" | "missing" | "error" | "not-applicable" | "warn";

export interface PreflightItem {
  check: PreflightCheckName;
  status: PreflightStatus;
  /** Absolute target path and the evidence behind the verdict. */
  detail: string;
  /** Guidance for a human; fix mode only automates npm install/build items. */
  fix?: string;
}
