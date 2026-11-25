/** Host composition and data-only profile authoring. Never returns compiled trees. */
export {configureProfileSource,type ProfileSourcePort,type ProfileSourceSnapshot,type ProfileDiagnostic} from '../registry.js';
export {configureNativeReads,type NativeReadPort} from '../ports.js';
export {validateProfile} from '../schema.js';
export {inferProfile,parseCommandSample,declarationUsage,unsupportedUsage,SetupSampleError,type SetupQuestion,type CommandSample} from '../setup.js';
export {checkSetupProfile,SetupRouteMismatch} from '../setup-compatibility.js';
export type {AgentProfile,UsageContract} from '../types.js';

export {bindingSchema,bindingShape,bindingIdSchema,validateInvocationBinding,bindingReference,resolveBindingReference,type InvocationBinding} from './declarations.js';
export {authoringSchemas,renderAgentOnboarding} from '../authoring.js';
