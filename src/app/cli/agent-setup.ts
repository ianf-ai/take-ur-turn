/** Optional declaration import/enhancement helper. Saving never runs a model. */
import {fileURLToPath} from 'node:url';
import {resolveRigRoot} from '../../hub/rig-discovery.js';
import {validateProfile} from '../../agents/public/configuration.js';
import {agentSetupStore} from '../agent-setup-store.js';
import {readDeclaration} from './agent-declaration.js';
import {runAgentAdd} from './agent.js';
export async function runAgentSetup(id:string,from?:string):Promise<number> {
 if(from===undefined) {
  process.stdout.write(`Optional import: tut agent setup ${id} --from <file|->\nMinimal invocation: tut agent add ${id} --from <file|->\nAuthor a declaration from local CLI --help / installation instructions, or fill it by hand.\nInstructions: ${fileURLToPath(new URL('../../../skills/agent-onboarding.md',import.meta.url))}\nNative session/resume/usage enhancement: import a complete profile declaration with --from.\nDiagnostic only (executes the CLI/model): tut agent probe ${id}\n`);
  return 0;
 }
 try {
  const raw=await readDeclaration(from);
  if(!raw||typeof raw!=='object'||!('schema_version' in raw)||raw.schema_version!==2) {
   // Minimal declarations use exactly the same validation and config writer as add.
   const {validateInvocationBinding}=await import('../../agents/public/configuration.js');
   return runAgentAdd(id,validateInvocationBinding(raw,id));
  }
  const profile=validateProfile(raw);
  if(profile.id!==id)throw Error('id: profile declaration must match setup id');
  const file=await agentSetupStore(resolveRigRoot()).install(profile);
  process.stdout.write(`agent: imported ${id} enhancement (${file})\nOptional diagnostic: tut agent probe ${id}\n`);
  return 0;
 }catch(error){process.stderr.write(`tut: agent setup: ${(error as Error).message}\n`);return 1;}
}
