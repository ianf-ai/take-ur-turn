/** Public authoring material rendered from the runtime Zod schemas. */
import {z} from 'zod';
import {bindingSchema,bindingShape} from './binding.js';
import {profileSchema} from './schema.js';
function jsonSchema(schema:z.ZodTypeAny):Record<string,unknown> {
 const d=schema._def as z.ZodTypeDef & Record<string,any>;
 let value:Record<string,unknown>;
 switch(d.typeName) {
  case 'ZodEffects': value=jsonSchema(d.schema);break;
  case 'ZodDefault':value=jsonSchema(d.innerType);value.default=d.defaultValue();break;
  case 'ZodOptional':value=jsonSchema(d.innerType);break;
  case 'ZodNullable':value={anyOf:[jsonSchema(d.innerType),{type:'null'}]};break;
  case 'ZodObject': {
   const shape=(schema as z.AnyZodObject).shape;
   value={type:'object',properties:Object.fromEntries(Object.entries(shape).map(([k,s])=>[k,jsonSchema(s as z.ZodTypeAny)])),required:Object.entries(shape).filter(([,s])=>!(s as z.ZodTypeAny).isOptional()).map(([k])=>k),additionalProperties:d.unknownKeys!=='strict'};break;
  }
  case 'ZodUnion':value={anyOf:d.options.map(jsonSchema)};break;
  case 'ZodEnum':value={type:'string',enum:d.values};break;
  case 'ZodLiteral':value={const:d.value};break;
  case 'ZodArray':value={type:'array',items:jsonSchema(d.type),...(d.minLength?{minItems:d.minLength.value}:{}),...(d.maxLength?{maxItems:d.maxLength.value}:{})};break;
  case 'ZodString':value={type:'string'};for(const c of d.checks) {
   if(c.kind==='min')value.minLength=c.value;
   else if(c.kind==='max')value.maxLength=c.value;
   else if(c.kind==='regex')value.pattern=c.regex.source;
  }break;
  case 'ZodNumber':value={type:d.checks.some((c:{kind:string})=>c.kind==='int')?'integer':'number'};for(const c of d.checks)if(c.kind==='min'||c.kind==='max')value[c.kind==='min'?'minimum':'maximum']=c.value;break;
  case 'ZodNull':value={type:'null'};break;
  case 'ZodBoolean':value={type:'boolean'};break;
  default:throw Error(`authoring schema renderer: unsupported ${d.typeName}`);
 }
 if(schema.description)value.description=schema.description;
 return value;
}
export function authoringSchemas() {
 return {binding:jsonSchema(bindingShape),profile:jsonSchema(profileSchema)};
}
export function renderAgentOnboarding():string {
 const example=bindingSchema.parse({schema_version:1,id:'worker-x',command:{executable:'worker-x-cli',argv:['run',{slot:'args'},{slot:'prompt'}]},input:{kind:'argv'}});
 const schema=authoringSchemas().binding;
 return `# Agent declaration authoring\n\nGenerated from the runtime binding/profile schemas. Update the schemas, then run\n\`node scripts/release/render-agent-instructions.mjs --write\` after compiling.\n\nRead the installed CLI's local \`--help\` and installation instructions. Choose its\nnoninteractive fresh invocation with task/tool access. Do not guess flags from\nthe agent name, use --last/--continue, or invoke another model to infer flags.\nA person can fill in the same declaration by hand; another agent is optional.\n\nMinimal complete example (replace the executable and fixed arguments using the\ninstalled CLI's help; the example is not a provider recommendation):\n\n\`\`\`json\n${JSON.stringify(example,null,2)}\n\`\`\`\n\nFrom an already running rig with an existing authorized task:\n\n1. \`tut agent add worker-x --from -\` accepts the JSON on stdin; alternatively\n   \`tut agent add worker-x --from declaration.json\` imports a file.\n2. \`tut assign executor binding:worker-x\` selects the explicit logical id.\n3. \`tut start-next <task-id>\` requests the normal authorized launch.\n\nImport does static validation only, with field paths in errors. Correct the\nreported fields and import again. No TTY, run/resume samples, session JSON,\nusage declaration, baseline commit, or probe score is required to save.\n\nStrings are literal argv values, including paths with spaces; no shell expansion\nis performed. NUL, template code and partial interpolation are rejected. Use\nwhole-argument slot objects. The args slot may occur at most once; if omitted,\nextra route args are rejected. argv input requires exactly one prompt slot;\nstdin input forbids it, uses encoding utf8 and sends the raw prompt then EOF.\nCwd is checkoutRoot; inherited environment, PWD and TUT locator/isolation rules\nremain host responsibilities. Use a direct executable, or an explicit\ninterpreter plus fixed script argv; do not use shell -c or script wrappers.\n\n\`binding:\` is reserved and resolves only config.agent_bindings. Missing/invalid\nbindings never fall back to PATH, bundled same-name profiles or agents artifacts.\nUnprefixed legacy routes retain their meaning. Static validity does not prove\nlogin, quota, network, tool access, Hub connectivity or successful task delivery.\n\nOptional native session/resume/usage enhancements: describe the complete native\nprofile using the packaged \`dist/agents/profile.schema.json\` and the runtime\nvalidator's field diagnostics, then import with\n\`tut agent setup <id> --from profile.json\`. Existing protected native contracts\nretain their scope/identity checks. A profile import does not implicitly attach\nan enhancement to a basic binding. \`tut agent setup <id>\` prints import guidance;\n\`tut agent probe <id>\` explicitly runs native diagnostics and may use the model.\nProbe failures preserve declarations and run evidence; they do not disable them.\n\nMachine-readable shape schemas ship at \`dist/agents/binding.schema.json\` and\n\`dist/agents/profile.schema.json\`. Runtime semantic refinements (slots, patterns,\ncapability consistency and protected native contracts) remain authoritative.\n\nBinding shape, rendered from the runtime schema:\n\n\`\`\`json\n${JSON.stringify(schema,null,2)}\n\`\`\`\n`;
}
