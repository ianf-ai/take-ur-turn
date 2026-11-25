/** Every parser dependency is frozen with its compiled registry, including a disabled peer. */
import {contentKey} from './content-key.js';
import {profileSchema} from './schema.js';
import type {UsageSource} from './types.js';
export interface UsageParseContext {readonly peerHeader:UsageSource['header']|null;readonly key:string}
const contexts=new WeakMap<object,UsageParseContext>();
const empty=Object.freeze({peerHeader:null,key:contentKey(null)});
export function bindUsageContext(profile:object,header:unknown):void {
 const peerHeader=header==null?null:profileSchema.shape.usage.shape.source.unwrap().shape.header.parse(header);
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
 freeze(peerHeader);
 contexts.set(profile,Object.freeze({peerHeader,key:contentKey(peerHeader)}));
}
export const usageContextFor=(profile:object):UsageParseContext=>contexts.get(profile)??empty;
export const usageSourceKey=(profile:{readonly key:unknown;readonly platform:string}):string=>contentKey([profile.key,profile.platform,usageContextFor(profile).key]);
