/** What down needs to stop one service. pid null = alive but not ours to
 *  signal (e.g. a hub this up only verified and reused). start_token is the
 *  recorded process-start fingerprint — down's identity proof that a live
 *  pid is still the SAME process instance this file was written about. */
export interface PowerFacts {
  pid: number | null;
  pgid: number | null;
  started_at: string;
  start_token?: string | null;
  process_scope?: "windows-tree";
}

/** Service facts plus the power session of THAT service's tree: the id up
 *  exported to the process (TUT_POWER_SESSION) whose non-detached children
 *  register under it. The session binds to the SURVIVING service instance —
 *  a reused service keeps its recorded session (its live tree still carries
 *  it); a freshly spawned service gets a new one. Absent for reused services
 *  without preserved facts (attribution impossible — down refuses their
 *  leaderless leftovers). An adopted service gets a new registration session
 *  with session_inherited=false: it was never exported into that process. */
export interface ServiceFacts extends PowerFacts {
  power_session?: string | null | undefined;
  /** Explicit adoption cannot inject TUT_POWER_SESSION into an existing tree. */
  adopted?: true;
  session_inherited?: false;
  /** Windows per-service completion allows retry after a later service fails. */
  stopped_at?: string;
}

/** The standalone rig's power state; down stops from this file. */
export interface PowerState {
  mode: "standalone";
  /** The rig allowed to control these process facts; absent on older snapshots. */
  owner_root?: string;
  started_at: string;
  hub: { url: string; port: number } & ServiceFacts;
  notifier: { event_port: number } & ServiceFacts;
  watcher?: (ServiceFacts & { pid: number }) | null;
  stopped_at?: string;
}
