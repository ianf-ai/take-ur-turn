/** Native OpenCode session identity, shared by run observation and launch planning. */
export function isOpencodeSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^ses_[a-zA-Z0-9]{1,124}$/u.test(id);
}
