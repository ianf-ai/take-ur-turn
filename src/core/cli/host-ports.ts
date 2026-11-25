import type { Cast, CheckoutRoute, Flow, LaunchRequest } from "../../protocol/types.js";
import type { LaunchEntry } from "../launcher/entry-parse.js";
import type { ParsedArgs } from "./args.js";

export interface StartNextTask {
  task_id: string;
  title?: string;
  version?: number;
  cast?: Cast;
  checkout?: CheckoutRoute;
  flow?: Flow;
}

/** Host effects are bound by the application after shared selection/gates. */
export interface TaskHostPort {
  registerLaunch: (name: string) => Promise<void>;
  launch: (entry: LaunchEntry) => Promise<number>;
  startNext: (parsed: Extract<ParsedArgs, { command: "start-next" }>, task: StartNextTask, request: LaunchRequest) => Promise<number>;
  cleanupTask: (taskId: string) => Promise<void>;
}

export interface PowerPort {
  up: (parsed: Extract<ParsedArgs, { command: "up" }>, cwd: string) => Promise<number>;
}
