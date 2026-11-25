/** Only bounded read operations are shared with the Windows helper. */
export interface RunFileStat { size: number; dev: number; ino: number; isFile(): boolean }
export interface RunFile {
  stat(): Promise<RunFileStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export type RunFileOpener = (file: string) => Promise<RunFile>;
