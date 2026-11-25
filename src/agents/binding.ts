/** Minimal invocation declarations: data only, with whole-argument slots. */
import { z } from 'zod';
import path from 'node:path';
import {assertBasicExecutable} from './basic-executable.js';
import {normalizeAgentRoute,validateAgentRoute} from '../protocol/agent-command.js';
const literal = z.string().refine(s => !s.includes('\0'), 'NUL is forbidden')
 .refine(s => !/\$\{|\$\(|`|\{\{|\}\}|\{(?:args|prompt)\}/u.test(s), 'template code and partial interpolation are forbidden; use a whole-argument slot');
export const bindingIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u, 'expected [a-z][a-z0-9-]{0,63}');
export const bindingShape = z.object({
 schema_version: z.literal(1).describe('Minimal invocation declaration version.'),
 id: bindingIdSchema.describe('Logical id, matching the agent add id.'),
 command: z.object({
  executable: literal.refine(s => s.trim().length > 0 && !/[\r\n|;&<>"']/u.test(s) && !/^\s|\s$/u.test(s), 'expected one executable path or PATH name, without shell syntax').refine(s => !/\.(?:cmd|bat|ps1)$/iu.test(s) && !/^(?:sh|bash|zsh|dash|fish|cmd|powershell|pwsh)(?:\.exe)?$/iu.test(path.win32.basename(s.replaceAll('\\','/'))), 'BINDING_SHELL_UNSUPPORTED: shell entrypoints and script wrappers are forbidden; use a direct executable or explicit interpreter plus script').describe('One executable; paths with spaces remain one value. Use an explicit interpreter and script for interpreter-based CLIs.'),
  argv: z.array(z.union([literal, z.object({slot:z.enum(['args','prompt'])}).strict()])).describe('Ordered literal strings or whole-argument slots. No shell, code, or partial interpolation.')
 }).strict(),
 input: z.union([z.object({kind:z.literal('argv')}).strict(),z.object({kind:z.literal('stdin'),encoding:z.literal('utf8')}).strict()]).describe('argv requires exactly one prompt slot; stdin forbids it and sends raw UTF-8 followed by EOF.')
}).strict();
export const bindingSchema = bindingShape.superRefine((b,ctx) => {
 for(const slot of ['args','prompt'] as const) {
  const positions=b.command.argv.flatMap((v,i)=>typeof v!=='string'&&v.slot===slot?[i]:[]);
  for(const i of positions.slice(1))ctx.addIssue({code:'custom',path:['command','argv',i],message:`duplicate ${slot} slot`});
  if(slot==='prompt'&&b.input.kind==='argv'&&!positions.length)ctx.addIssue({code:'custom',path:['command','argv'],message:'argv input requires exactly one prompt slot'});
  if(slot==='prompt'&&b.input.kind==='stdin')for(const i of positions)ctx.addIssue({code:'custom',path:['command','argv',i],message:'stdin input forbids a prompt slot'});
 }
});
export type InvocationBinding = z.infer<typeof bindingSchema>;
export function validateInvocationBinding(raw:unknown,id?:string):InvocationBinding {
 const result=bindingSchema.safeParse(raw);
 if(!result.success)throw Error(result.error.issues.map(i=>`${i.path.join('.')||'binding'}: ${i.message}`).join('\n'));
 if(id!==undefined&&result.data.id!==id)throw Error(`id: declaration '${result.data.id}' does not match '${id}'`);
 assertBasicExecutable(result.data.command.executable);
 return result.data;
}
export function bindingReference(agent:string):string|undefined {
 if(!agent.startsWith('binding:'))return undefined;
 const id=agent.slice('binding:'.length),result=bindingIdSchema.safeParse(id);
 if(!result.success)throw Error('binding reference.id: expected [a-z][a-z0-9-]{0,63}');
 return id;
}
/** Invocation-owned fields are validated; unrelated persisted metadata stays inert. */
const invocationFields = ['schema_version','id','command','input','executable','args','prompt'] as const;
function storedFields(raw:unknown):Record<string,unknown> {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('binding: expected an object');
 return Object.fromEntries(invocationFields.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,(raw as Record<string,unknown>)[k]]));
}
export type LegacyInvocationBinding = {executable:string;args:string[];prompt:{kind:'stdin'}|{kind:'argv';index:number}};
export function parseLegacyInvocationBinding(raw:unknown):LegacyInvocationBinding {
 const fields=storedFields(raw);
 const command=normalizeAgentRoute(validateAgentRoute({agent:fields.executable,args:fields.args},'agent binding'));
 const prompt=fields.prompt as {kind?:unknown;index?:unknown}|undefined;
 if(prompt?.kind==='stdin')return {executable:command.agent,args:command.args,prompt:{kind:'stdin'}};
 if(prompt?.kind==='argv'&&Number.isSafeInteger(prompt.index)&&(prompt.index as number)>=0&&(prompt.index as number)<=command.args.length)
  return {executable:command.agent,args:command.args,prompt:{kind:'argv',index:prompt.index as number}};
 throw Error('agent binding.prompt must be stdin or argv with an insertion index from 0 to args.length');
}
export function parseStoredInvocationBinding(raw:unknown):InvocationBinding {
 return validateInvocationBinding(storedFields(raw));
}
/** Old declarations describe fixed argv only; extra route args need an explicit new slot. */
export function normalizeInvocationBinding(raw:unknown,id:string):InvocationBinding {
 const fields=storedFields(raw);
 if(['schema_version','command','input'].some(k=>Object.hasOwn(fields,k)))return validateInvocationBinding(fields,id);
 const legacy=parseLegacyInvocationBinding(fields);
 const argv:InvocationBinding['command']['argv']=[...legacy.args];
 if(legacy.prompt.kind==='argv')argv.splice(legacy.prompt.index,0,{slot:'prompt'});
 return validateInvocationBinding({schema_version:1,id,command:{executable:legacy.executable,argv},input:legacy.prompt.kind==='stdin'?{kind:'stdin',encoding:'utf8'}:{kind:'argv'}},id);
}
/** Explicit references never consult executable matching or a profile catalog. */
export function resolveBindingReference(agent:string,args:readonly string[],bindings:unknown):InvocationBinding|undefined {
 const id=bindingReference(agent);if(id===undefined)return undefined;
 if(!bindings||typeof bindings!=='object'||Array.isArray(bindings)||!Object.hasOwn(bindings,id))throw Error(`agent_bindings.${id}: binding not found`);
 const binding=normalizeInvocationBinding((bindings as Record<string,unknown>)[id],id);
 if(args.length&&!binding.command.argv.some(v=>typeof v!=='string'&&v.slot==='args'))throw Error(`agent_bindings.${id}.command.argv: route args require an args slot`);
 return binding;
}
