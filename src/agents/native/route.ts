/** Native CLI boundaries. These policies also serve aliases and workspace profiles. */
import type { RoutePolicy, NativeRoute } from '../types.js';
import type { Failure } from '../projection.js';
import {codexRootValues,codexRootFlags,codexSharedValues,codexSharedFlags} from './codex/options.js';
import {piValues,piSelectors} from './pi/options.js';
import {opencodeValues,opencodeSelectors} from './opencode/options.js';
export {codexRootValues,codexRootFlags,codexSharedValues,codexSharedFlags,piValues};
export function selects(token:string,policy:NativeRoute):boolean {
 const names=policy==='pi'?piSelectors:policy==='opencode'?opencodeSelectors:[];
 return names.some(n=>token===n||token.startsWith(n+'='))||(policy==='opencode'&&['-s','-c'].some(n=>token.startsWith(n)&&token.length>n.length));
}
export const routeFailure=(code:string,token='',option=token):Failure=>({status:'invalid',code,reason:code,token,option});
export type ParsedRoute={status:'ready';groups:Record<string,string[]>;seen:Set<string>;optionIndices?:readonly number[]};
export function parseRoute(policy:RoutePolicy,args:readonly string[]):ParsedRoute|Failure {
 const groups:Record<string,string[]>={args:[],root:[],parent:[],shared:[],nonroot:[],options:[]},seen=new Set<string>();
 if(policy==='passthrough')return {status:'ready',groups:{...groups,args:[...args],options:[...args]},seen};
 if(policy==='pi'&&args.some(a=>selects(a,policy)))return routeFailure('SESSION_SELECTOR');
 const optionIndices:number[]=[];let command=false;
 for(let i=0;i<args.length;i++) {
  const token=args[i]!;
  if(policy!=='pi'&&token===(policy==='codex'?'exec':'run')&&!command){command=true;continue;}
  if(policy==='opencode'&&selects(token,policy))return routeFailure('SESSION_SELECTOR',token);
  optionIndices.push(i);
  let name=policy==='pi'?token:token.split('=',1)[0]!,form: 'separate'|'equals'|'attached'=policy!=='pi'&&token.includes('=')?'equals':'separate';
  const codexValue=[...codexRootValues,...codexSharedValues,'--color'];
  if(policy==='codex'&&!codexValue.includes(name)&&!token.startsWith('--')&&['-m','-c','-s','-o','-a','-p'].some(n=>token.startsWith(n)&&token.length>n.length)){name=token.slice(0,2);form='attached';}
  const values=policy==='codex'?codexValue:policy==='pi'?[...piValues,'--mode']:opencodeValues;
  const flags=policy==='codex'?[...codexRootFlags,...codexSharedFlags]:policy==='pi'?['--print','-p','--mode=json']:['--auto','--thinking','--standalone','--print-logs'];
  const takesValue=values.includes(name),flag=flags.includes(name)&&form==='separate';
  if(!takesValue&&!flag) {
   if(policy==='pi'&&token.startsWith('--mode='))return routeFailure('LITERAL',token,'--mode');
   if(policy==='pi'&&token.startsWith('-')&&token!=='--'){groups.options!.push(token);groups.args!.push(token);continue;}
   return routeFailure('ARGUMENT',token);
  }
  const words=[token];
  if(takesValue) {
   const value=form==='separate'?args[++i]:form==='equals'?token.slice(name.length+1):token.slice(name.length);
   const literal=policy==='pi'&&name==='--mode'||policy==='opencode'&&name==='--format';
   const valid=value!==undefined&&(policy==='pi'||form!=='separate'||!value.startsWith('-'))&&(policy==='codex'?(form==='separate'||!token.endsWith('=')):policy==='pi'||value.length>0);
   if(!valid)return routeFailure('MISSING_VALUE',token,name);
   if(literal&&value!=='json')return routeFailure('LITERAL',token,name);
   if(form==='separate')words.push(value!);
  }
  if((policy==='codex'&&name==='--json'||policy==='opencode'&&name==='--format')&&seen.has(name))return routeFailure('DUPLICATE',token,name);
  seen.add(name);
  const scope=policy!=='codex'?'options':codexRootValues.includes(name)||codexRootFlags.includes(name)?'root':name==='--color'?'parent':'shared';
  groups[scope]!.push(...words);groups.args!.push(...words);
  if(scope!=='root')groups.nonroot!.push(...words);
 }
 groups.options=groups.args!;
 if(policy==='opencode'&&!seen.has('--auto'))return routeFailure('REQUIRED','--auto');
 groups.json=seen.has('--json')||seen.has('--format')?[]:policy==='codex'?['--json']:policy==='opencode'?['--format','json']:[];
 groups.print=seen.has('--print')||seen.has('-p')?[]:['--print'];
 groups.mode=seen.has('--mode')||seen.has('--mode=json')?[]:['--mode','json'];
 return {status:'ready',groups,seen,optionIndices};
}
export function probeArgs(policy:RoutePolicy):string[]{return policy==='opencode'?['--auto']:[];}
