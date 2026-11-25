import {parseStoredInvocationBinding,parseLegacyInvocationBinding, type InvocationBinding} from '../../agents/public/declarations.js';
/** Pure declarations for the rig's human routing and invocation intent. */
import { parseAgentRoute, validateAgentRoute } from "../../protocol/agent-command.js";
import type { AgentRoute } from "../../protocol/types.js";

export const KNOWN_ROLES = ["architect", "executor", "reviewer"] as const;
export type RoleDeclarations = Record<string, { agent: string; args?: string[]; [key: string]: unknown }>;
export type LegacyAgentBinding = { executable: string; args: string[]; prompt: { kind: "stdin" } | { kind: "argv"; index: number } };

export type AgentBinding = LegacyAgentBinding | InvocationBinding;

export function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

/** Config roles are authoritative: malformed declarations never fall through. */
export function parseConfigRoles(value: unknown): Record<string, AgentRoute> {
  const roles = objectOf(value, "config.roles");
  return Object.fromEntries(Object.entries(roles).map(([role, entry]) => {
    const fields = objectOf(entry, `config.roles.${role}`);
    const route = fields.args === undefined && typeof fields.agent === "string"
      ? parseAgentRoute(fields.agent, `config.roles.${role}`)
      : validateAgentRoute(fields, `config.roles.${role}`);
    return [role, route];
  }));
}

/** Ordered fixed argv; index is the insertion position among args (0..length). */
export function parseAgentBinding(value: unknown): AgentBinding {
  const raw = objectOf(value, "agent binding");
  if (['schema_version','command','input'].some(key=>Object.hasOwn(raw,key))) return parseStoredInvocationBinding(raw);
  return parseLegacyInvocationBinding(raw);
}

export function validateBindingId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) throw new Error("agent id must match [a-z][a-z0-9-]{0,63}");
}
