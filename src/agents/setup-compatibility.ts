import {loadAgentProfiles,ProfileRegistry} from './registry.js';
import {validateProfile} from './schema.js';
import {commandWords} from './template.js';
import type {AgentProfile} from './types.js';
export class SetupRouteMismatch extends Error {
 constructor(readonly question:'run'|'resume',message:string){super(message);}
}

export function checkSetupProfile(root:string,profile:AgentProfile):void {
  validateProfile(profile);
  const current=loadAgentProfiles(root),previous=current.get(profile.id);
  // Compatibility check only: never use the previous profile to generate a
  // command. Its registered route cannot silently become generic passthrough.
  if(previous&&previous.value.invoke.route!==profile.invoke.route)throw new SetupRouteMismatch('run',`PROFILE_INVALID：${profile.id} 已登记参数规则 ${previous.value.invoke.route}，输入规则 ${profile.invoke.route} 会改变原有作用域；请在 run 前显式声明 @${previous.value.invoke.route} 并标记分组位置`);
  if(previous)for(const mode of ['run','resume'] as const) {
   const before=previous.value.invoke[mode],after=profile.invoke[mode];
   // Equal normalized command tails + equal route policy preserve all argv
   // scopes, not just the empty route exercised by a smoke probe. The head
   // is ignored because invocation always uses the matched route executable.
   if(before.tier==='declarative'&&(after.tier!=='declarative'||JSON.stringify(commandWords(before.spec).slice(1))!==JSON.stringify(commandWords(after.spec).slice(1))))throw new SetupRouteMismatch(mode,`PROFILE_INVALID：${mode} 模板会改变已登记的命令或参数作用域；请保留完整固定参数和分组槽。已有声明：${before.spec}`);
  }
  const values=current.all().filter(p=>p.id!==profile.id).map(p=>p.value);
  const registry=new ProfileRegistry([...values,profile]);
  if(!registry.get(profile.id))throw Error(registry.diagnostics.filter(d=>d.id===profile.id).map(d=>`${d.code}: ${d.reason}`).join('; '));
}
