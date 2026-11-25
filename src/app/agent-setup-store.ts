/** Application composition of profile persistence and the rig admission mutex. */
import {AgentSetupStore} from '../core/agents/setup-store.js';
import {RunStore} from '../core/run/store.js';
export const agentSetupStore=(root:string)=>new AgentSetupStore(root,()=>new RunStore(root).lockAdmission());
