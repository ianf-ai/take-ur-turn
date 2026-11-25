/** TRANSITION: named native exits used by legacy run paths; delete when legacy native run paths retire. */
export {codexArgv} from '../native/codex/argv.js';
export {opencodeArgv} from '../native/opencode/argv.js';
export {windowsPiRouteArgs,resolveWindowsPiPath,windowsPiEncodedCwd,windowsPiSessionLocation,verifyWindowsPiSession,verifyWindowsPiContinuation,type WindowsPiSession,type WindowsPiSessionLocation} from '../native/pi/windows-session.js';
export {resolveLegacyWindowsTarget} from '../native/windows-target.js';
export {npmPiShim} from '../native/pi/windows-target.js';
export type {WindowsTargetServices,LegacyWindowsTarget} from '../windows-target-contract.js';
import {nativeComposer,pendingCodexInput} from '../native/codex/composer.js';
export const nativeComposerPolicy=(agent:string|undefined)=>agent==='codex'?nativeComposer:{settleMs:0,inputTail:false,basis:'text-transport-sent' as const};
export const pendingNativeInput=pendingCodexInput;
export type NativeInputBasis=typeof nativeComposer.basis;
export {piSessionDirFor,readPiSessionHead,verifyPiSession,type PiSessionHead} from '../native/pi/posix-session.js';
export {physicalWindowsArgv} from '../native/windows-invocation.js';
