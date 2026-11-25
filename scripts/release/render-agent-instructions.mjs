/** Generate public schemas and verify the checked-in authoring instructions. */
import {readFileSync,writeFileSync} from 'node:fs';
import {authoringSchemas,renderAgentOnboarding} from '../../dist/agents/public/configuration.js';
const instructions=renderAgentOnboarding(),file=new URL('../../skills/agent-onboarding.md',import.meta.url);
if(process.argv.includes('--write'))writeFileSync(file,instructions);
else if(readFileSync(file,'utf8')!==instructions)throw Error('agent authoring instructions drift: compile, then render-agent-instructions.mjs --write');
for(const [name,schema] of Object.entries(authoringSchemas()))writeFileSync(new URL(`../../dist/agents/${name}.schema.json`,import.meta.url),JSON.stringify(schema,null,2)+'\n');
