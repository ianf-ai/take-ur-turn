import path from 'node:path';

export const auditPath = options => (options?.platform ?? process.platform) === 'win32' ? path.win32 : path;
