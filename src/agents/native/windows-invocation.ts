/** Assemble the host-verified physical target; never resolve or launch a process. */
export function physicalWindowsArgv<T extends {executable:string;prefix_args:readonly string[]}>(target:T,logical:readonly string[],session?:{session_directory:string}):string[] {
 const args=logical.slice(1);
 if(session) {
  const separator=args.lastIndexOf('--');
  if(separator<0)throw Error('pi argv has no prompt separator');
  args.splice(separator,0,'--session-dir',session.session_directory);
 }
 return [target.executable,...target.prefix_args,...args];
}
