/** Read-only native facts supplied by the host. No rig or task-store discovery. */
export interface NativeReadPort {
 head(file:string):string|undefined;
 home():string;
 platform():NodeJS.Platform;
 readSettings(file:string):string|undefined;
 entries(directory:string):string[];
 header(file:string):{id?:unknown;cwd?:unknown;type?:unknown}|undefined;
 realpath(file:string):string;
}
let reads:NativeReadPort|undefined;
export function configureNativeReads(port:NativeReadPort):void {reads=port;}
export function nativeReadPort():NativeReadPort {if(!reads)throw Error('native read services not configured');return reads;}
