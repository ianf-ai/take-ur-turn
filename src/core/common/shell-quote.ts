/** A PaneCommand field violated the raw-input contract. */
export class PaneCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneCommandError";
  }
}

/** Reject the characters no pane command may ever carry. */
export function assertRawString(value: string, field: string): void {
  if (typeof value !== "string" || /[\u0000\r\n]/u.test(value)) {
    throw new PaneCommandError(`${field} must be a string without NUL/CR/LF`);
  }
}

/** PowerShell single-quote: wrap in '…' and double each embedded '. */
export function psq(value: string): string {
  assertRawString(value, "psq input");
  return `'${value.replaceAll("'", "''")}'`;
}
