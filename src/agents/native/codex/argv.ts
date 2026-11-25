/** Backward compatible native argv exit; contract is in the bundled profile. */
import { profileArgv } from '../../legacy.js';
import { agentProfiles } from '../../registry.js';
export function codexArgv(agent:string,args:readonly string[],prompt:string,session?:string):string[] {
 return profileArgv({agent,args},prompt,session,agentProfiles.get('codex'));
}
