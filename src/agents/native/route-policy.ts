/**
 * Freeze the agent self-update suppression policy once, keyed by the bare
 * route agent's logical name — never by a wrapped command or resolved path.
 */
export function selfUpdatePolicyFor(
  routeAgent: string,
  routeArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
): {args:string[];env:Record<string,string>} {
  const suppress = environment.TUT_SUPPRESS_AGENT_UPDATE !== "0";
  if (!suppress) return { args: [...routeArgs], env: {} };
  if (routeAgent === "codex") {
    return { args: [...routeArgs, "-c", "check_for_update_on_startup=false"], env: {} };
  }
  if (routeAgent === "pi") {
    return { args: [...routeArgs], env: { PI_SKIP_VERSION_CHECK: "1" } };
  }
  return { args: [...routeArgs], env: {} };
}
