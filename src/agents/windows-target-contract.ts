export interface PhysicalTarget {kind:'native'|'node-entry';executable:string;prefix_args:string[];source_path:string}
export interface LegacyWindowsTarget extends PhysicalTarget {agent:string;version?:string}
export interface WindowsTargetServices {
 nodeExecutable:string;
 readText(file:string):Promise<string>;
 regular(file:string):Promise<void>;
 resolve(command:string,explicit:boolean):Promise<PhysicalTarget>;
 shimPath(error:unknown):string|undefined;
}
