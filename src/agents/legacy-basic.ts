/** Frozen schema-1 basic snapshots retain their original data grammar.
 * New declarations use binding.ts; this decoder never promotes old literals
 * or inert metadata into the current authoring language. */
import type {InvocationBinding} from './binding.js';
import {assertBasicExecutable} from './basic-executable.js';
import {protectedNativeCommand} from './native/protection.js';
import type {Platform} from './types.js';
const word=(value:unknown):value is string=>typeof value==='string'&&!value.includes('\0');
export function legacyBasicBinding(raw:unknown,platform:Platform):InvocationBinding {
 const b=raw as InvocationBinding;
 if(!b||b.schema_version!==1||typeof b.id!=='string'||!/^[-a-z0-9]+$/.test(b.id)||!b.command||!word(b.command.executable)||!b.command.executable||!Array.isArray(b.command.argv)||!b.input||!['argv','stdin'].includes(b.input.kind))throw Error('BINDING_INVALID');
 let args=0,prompt=0;
 for(const value of b.command.argv){if(word(value))continue;if(!value||Object.keys(value).length!==1||!['args','prompt'].includes(value.slot))throw Error('BINDING_SLOT_INVALID');if(value.slot==='args')args++;else prompt++;}
 if(args>1||prompt!==(b.input.kind==='argv'?1:0)||b.input.kind==='stdin'&&b.input.encoding!=='utf8')throw Error('BINDING_SLOT_INVALID');
 assertBasicExecutable(b.command.executable);
 if(protectedNativeCommand(b.command.executable,b.command.argv,platform))throw Error('BINDING_NATIVE_CONFLICT');
 return {schema_version:1,id:b.id,command:{executable:b.command.executable,argv:structuredClone(b.command.argv)},input:b.input.kind==='stdin'?{kind:'stdin',encoding:'utf8'}:{kind:'argv'}};
}
