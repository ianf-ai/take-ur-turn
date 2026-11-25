/** Historical peer headers belong to the selected registry, never the live rig. */
export function legacyUsagePeerId(id:string,attribution:string):string|undefined {
 return (id==='codex'||id==='pi')&&attribution==='legacy-cwd-window-v1'?(id==='codex'?'pi':'codex'):undefined;
}
