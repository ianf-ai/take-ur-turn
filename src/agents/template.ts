/** Whitespace separates words; quotes group literals. Expansion never invokes a shell. */
export const placeholders = new Set('executable prompt session model effort cwd args options root parent shared nonroot json print mode'.split(' '));
export function commandWords(command:string):string[] {
 const words:string[]=[];let word='',quote='',started=false;
 for(let i=0;i<command.length;i++) {
  const c=command[i]!;
  if(c==='\0')throw Error('NUL is forbidden');
  if(quote) {if(c===quote)quote='';else word+=c;started=true;}
  else if(c==='"'||c==="'"){quote=c;started=true;}
  else if(/\s/u.test(c)){if(started){words.push(word);word='';started=false;}}
  else {word+=c;started=true;}
 }
 if(quote)throw Error('unclosed command quote');
 if(started)words.push(word);
 if(!words.length||!words[0])throw Error('command needs an executable');
 for(const word of words)if(/[{}]/u.test(word)&&(!/^\{[a-z]+\}$/u.test(word)||!placeholders.has(word.slice(1,-1))))throw Error('unknown or partial command placeholder');
 if(words[0]!.includes('{')&&words[0]!=='{executable}')throw Error('command head must be an executable');
 if(words.slice(1).includes('{executable}'))throw Error('executable placeholder must be first');
 return words;
}
