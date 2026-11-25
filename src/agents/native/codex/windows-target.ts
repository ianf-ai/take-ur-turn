import type {PhysicalTarget,LegacyWindowsTarget} from '../../windows-target-contract.js';
export const isCodexWindowsName=(name:string)=>name==='codex'||name==='codex.exe';
export function verifyCodexTarget(target:PhysicalTarget):LegacyWindowsTarget {
 if(target.kind!=='native')throw Error('Windows detached codex requires a native executable');
 return {...target,agent:'codex'};
}
