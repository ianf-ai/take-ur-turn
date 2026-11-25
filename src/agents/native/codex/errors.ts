import type {Failure} from '../../projection.js';
export const messages:Partial<Record<string,(f:Failure)=>string>>={ARGUMENT:f=>`unsupported headless codex route argument: ${f.token}`,MISSING_VALUE:f=>`missing value for ${f.option}`,DUPLICATE:()=> 'duplicate headless codex --json'};
