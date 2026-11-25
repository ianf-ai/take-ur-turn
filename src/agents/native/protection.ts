/** Basic declarations cannot weaken bundled native safety, including interpreter aliases. */
import path from 'node:path';
import {bundledNativeTargetClaim} from '../registry.js';
import type {Platform} from '../types.js';
export function protectedNativeCommand(executable:string,argv:readonly unknown[],platform:Platform,verifiedTarget?:string):boolean {
 const name=path.win32.basename(executable).replace(/\.(exe|cmd|bat)$/i,'').toLowerCase();
 if(bundledNativeTargetClaim(name,platform,verifiedTarget)!==undefined)return true;
 return bundledNativeTargetClaim('pi',platform)!==undefined&&[executable,...argv].some(v=>typeof v==='string'&&/[\\/]@earendil-works[\\/]pi-coding-agent[\\/]/i.test(v));
}
