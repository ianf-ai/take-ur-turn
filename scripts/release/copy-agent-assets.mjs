/** Preserve the agents JSON asset layout alongside compiled modules. */
import {readdirSync,mkdirSync,copyFileSync} from 'node:fs';
import path from 'node:path';
function copy(relative='') {
 const source=path.join('src/agents',relative);
 for(const entry of readdirSync(source,{withFileTypes:true})) {
  const file=path.join(relative,entry.name);
  if(entry.isDirectory())copy(file);
  else if(entry.isFile()&&entry.name.endsWith('.json')) {
   const target=path.join('dist/agents',file);mkdirSync(path.dirname(target),{recursive:true});copyFileSync(path.join('src/agents',file),target);
  }
 }
}
copy();
