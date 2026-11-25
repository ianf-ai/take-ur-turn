/** Pure grammar and JSON projection primitives shared by both invocation paths. */
import type { Guard, PathRef, StringRule } from './types.js';
export interface Failure { status:'unsupported'|'invalid'|'error'; code:string; reason:string; option?:string; token?:string }
export function valueAt(root:unknown,path:PathRef):unknown {
 let v=root;for(const k of path){if(v===null||typeof v!=='object'||!Object.hasOwn(v,k))return undefined;v=(v as Record<string|number,unknown>)[k];}return v;
}
export function stringMatches(value:unknown,rule:StringRule):value is string {return typeof value==='string'&&value.length<=rule.max_length&&new RegExp(rule.pattern,rule.flags).test(value);}
export function guardsMatch(root:unknown,guards:Guard[]):boolean {
 return guards.every(g=>{const v=valueAt(root,g.path);switch(g.op){case'eq':return v===g.value;case'one-of':return typeof v==='string'&&g.values.includes(v);case'string':return typeof v==='string';case'finite-number':return typeof v==='number'&&Number.isFinite(v);case'absent-or-null':return v===undefined||v===null;}});
}
