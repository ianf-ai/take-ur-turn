/** Production composition: agents never discovers a rig or imports RunStore. */
import {configureProfileSource,configureNativeReads} from '../agents/public/configuration.js';
import {loadProfileSource,withAgentProfileSnapshot} from '../core/agents/profile-source.js';
import {nativeReads} from '../core/agents/native-reads.js';
configureProfileSource({load:loadProfileSource,withSnapshot:withAgentProfileSnapshot});
configureNativeReads(nativeReads);
