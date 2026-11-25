/** A raw command or quote input violated the shared string contract. */
export class PaneCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneCommandError";
  }
}

/** Reject characters forbidden at the raw command/quote boundary. */
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

/** Neutral alias; the historical constructor and error.name remain unchanged. */
export { PaneCommandError as CommandInputError };
