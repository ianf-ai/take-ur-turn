import {readFile} from 'node:fs/promises';
/** Files are import sources, never a second long-lived configuration home. */
export async function readDeclaration(from:string):Promise<unknown> {
 const text=from==='-' ? await readStdin() : await readFile(from,'utf8');
 try {return JSON.parse(text);}catch(error){throw Error(`declaration JSON: ${(error as Error).message}`);}
}
async function readStdin():Promise<string> {
 const chunks:Buffer[]=[];
 for await(const chunk of process.stdin)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
 return Buffer.concat(chunks).toString('utf8');
}
