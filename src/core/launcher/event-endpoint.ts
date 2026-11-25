import { DEFAULT_NOTIFIER_EVENT_URL, resolveNotifierEventEndpoint } from "../../hub/rig-discovery.js";

/** Prefer explicit producer configuration. Otherwise bind a manual launch to
 *  its verified workspace Notifier. Only the default local deployment keeps
 *  the visible legacy fallback; another rig must never send to port 3002. */
export async function ensureNotifierEventUrl(environment: NodeJS.ProcessEnv, hubUrl: string, hubRoot: string): Promise<void> {
  const explicit = environment.TUT_EVENT_PORT_URL;
  if (explicit !== undefined && explicit.length > 0) return;
  try {
    environment.TUT_EVENT_PORT_URL = await resolveNotifierEventEndpoint(hubUrl, hubRoot);
  } catch (error) {
    const hub = new URL(hubUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hub.hostname) || hub.port !== "3001") {
      throw new Error(`notifier endpoint discovery failed for ${hubUrl}; refusing default-port fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
    environment.TUT_EVENT_PORT_URL = DEFAULT_NOTIFIER_EVENT_URL;
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim() || "unknown discovery error";
    process.stderr.write(`tut: WARNING: notifier endpoint discovery failed; escalation will use ${DEFAULT_NOTIFIER_EVENT_URL}: ${reason}\n`);
  }
}
