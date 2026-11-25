import path from 'node:path';
/** Shared by declaration validation and the final physical-target check. */
export function assertBasicExecutable(executable:string):void {
 const name=path.win32.basename(executable).replace(/\.(exe|com)$/i,'').toLowerCase();
 // POSIX shell families include their common alternate and versioned names.
 const posixShell=/^(?:sh|bash|dash|ash|ksh|mksh|pdksh|lksh|csh|tcsh|zsh|yash|osh)(?:\d+(?:\.\d+)*)?$/;
 if(/\.(cmd|bat|ps1|sh)$/i.test(executable)||posixShell.test(name)||['fish','oil','elvish','nu','cmd','command','powershell','pwsh'].includes(name))throw Error('BINDING_SHELL_UNSUPPORTED');
}
