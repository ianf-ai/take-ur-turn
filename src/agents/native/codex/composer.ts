/** Inspect only the last Codex composer, never a matching historical prompt. */
export function pendingCodexInput(screen: string, tail: {length:number;sha256:string}|undefined, promptTailEvidence:(text:string)=>{length:number;sha256:string}): boolean {
  if (!tail || tail.length < 1 || tail.length > 80 || !/^[a-f0-9]{64}$/.test(tail.sha256)) return false;
  const lines = screen.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^› /u.test(lines[i]!)) start = i;
  if (start < 0) return false;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.trim() === '');
  if (end < 0) return false;
  const footer = rest.slice(end).filter(line => line.trim() !== '');
  // Anything between the candidate input and footer could be a response to
  // an already consumed historical prompt, so reject the whole snapshot.
  if (!footer.length || !footer.every(line => /^ {2}\? for shortcuts\b/u.test(line) || /^ {2}GPT-\S+.* · \S/u.test(line))) return false;
  const input = [lines[start]!.slice(2), ...rest.slice(0, end)].join('\n');
  const actual = promptTailEvidence(input);
  return actual.length === tail.length && actual.sha256 === tail.sha256;
}

export const nativeComposer={settleMs:250,inputTail:true,basis:"codex-input-tail" as const};
