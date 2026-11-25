import '../../../dist/app/agents.js';
export { instant, vector } from '../../../dist/agents/public/usage.js';
import { localFs } from './io.mjs';
import path from 'node:path';
export async function files(root, options = {}, pattern = '**/*.jsonl') {
  const fs = localFs(options), parts=pattern.split('/');
  const segment=(name,part)=>new RegExp('^'+part.split('*').map(s=>s.replaceAll('.','\\.')).join('.*')+'$').test(name);
  function matches(names,i=0,j=0) {
    if(j===parts.length)return i===names.length;
    if(parts[j]==='**')return matches(names,i,j+1)||(i<names.length&&matches(names,i+1,j));
    return i<names.length&&segment(names[i],parts[j])&&matches(names,i+1,j+1);
  }
  async function walk(directory,prefix=[]) {
    let entries;
    try {entries=await fs.readdir(directory,{withFileTypes:true});}
    catch(e) {if(e.code==='ENOENT')return [];throw e;}
    const result=[];
    for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(directory,e.name),relative=[...prefix,e.name];
      if(e.isDirectory())result.push(...await walk(file,relative));
      else if(e.isFile()&&matches(relative))result.push(file);
    }
    return result;
  }
  return walk(root);
}
