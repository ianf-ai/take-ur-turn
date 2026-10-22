/** Scope options according to the native root / exec / exec resume parsers. */
const globalValues = new Set(['-m', '--model', '-c', '--config', '-s', '--sandbox', '-a', '--ask-for-approval', '-p', '--profile', '--enable', '--disable', '--add-dir', '--local-provider']);
const globalFlags = new Set(['--strict-config', '--oss', '--search', '--no-daemon', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']);
const execValues = new Set(['--thread-source', '--cyber-access-program', '--output-schema', '-o', '--output-last-message']);
const execFlags = new Set(['--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json']);
const parentValues = new Set(['--color']);
const valueOptions = new Set([...globalValues, ...execValues, ...parentValues]);

export function codexArgv(agent: string, args: readonly string[], prompt: string, session?: string): string[] {
  const global: string[] = [], exec: string[] = [], parent: string[] = [], resume: string[] = [];
  let explicitExec = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === 'exec' && !explicitExec) { explicitExec = true; continue; }
    let option = token.split('=', 1)[0]!;
    let attached = token.includes('=');
    if (!valueOptions.has(option) && /^-[mcsoap].+/u.test(token) && !token.startsWith('--')) {
      option = token.slice(0, 2); attached = true;
    }
    const scope = globalValues.has(option) || globalFlags.has(option) ? global
      : parentValues.has(option) ? parent : execValues.has(option) || execFlags.has(option) ? resume : undefined;
    if (!scope || (attached && !valueOptions.has(option))) throw new Error(`unsupported headless codex route argument: ${token}`);
    const words = [token];
    if (valueOptions.has(option)) {
      if (attached) {
        if (token.endsWith('=')) throw new Error(`missing value for ${option}`);
      } else {
        const value = args[++i];
        if (value === undefined || value.startsWith('-')) throw new Error(`missing value for ${option}`);
        words.push(value);
      }
    }
    if (option === '--json') {
      if (json) throw new Error('duplicate headless codex --json');
      json = true;
    }
    scope.push(...words);
    if (scope !== global) exec.push(...words);
  }
  // Fresh keeps the exec options in their original order. Resume leaves
  // parent-only options (currently color) on exec and sends shared options
  // to resume. Global sandbox/profile/approval settings remain on the root.
  return [agent, ...global, 'exec', ...(session ? [...parent, 'resume', ...resume] : exec),
    ...(!json ? ['--json'] : []), ...(session ? [session] : []), prompt];
}
