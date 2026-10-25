import { afterEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import * as files from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { openRunFile } from "../src/core/hub/run-file.js";

// These are injected Darwin/Linux lookup tests, with no kernel opens. Supply
// POSIX path/flag facts even when the runner itself is Windows.
vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.posix };
});
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, constants: { ...actual.constants,
    O_NOFOLLOW: actual.constants.O_NOFOLLOW ?? 0x20000,
    O_DIRECTORY: actual.constants.O_DIRECTORY ?? 0x10000,
    O_NONBLOCK: actual.constants.O_NONBLOCK ?? 0x800,
  } };
});
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
afterEach(() => vi.restoreAllMocks());
function handle(fd: number) { return { fd, close: vi.fn(async () => {}) } as unknown as FileHandle; }

describe("run file OS lookup boundary", () => {
  it("uses Darwin's all-component guard without the incompatible final-component flag", async () => {
    const file = handle(20);
    const opened = vi.spyOn(files, "open").mockResolvedValue(file);
    expect(await openRunFile("/storage/runs/id/log", "darwin", "20.0.0")).toBe(file);
    expect(opened).toHaveBeenCalledWith("/storage/runs/id/log", constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
    expect((opened.mock.calls[0]![1] as number) & constants.O_NOFOLLOW).toBe(0);
  });
  it("walks Linux directories via held fd anchors, never by a mutable full parent path", async () => {
    const dirs = [handle(21), handle(22), handle(23), handle(24)], file = handle(25);
    const opened = vi.spyOn(files, "open");
    for (const dir of [...dirs, file]) opened.mockResolvedValueOnce(dir);
    expect(await openRunFile("/storage/runs/id/log", "linux")).toBe(file);
    expect(opened.mock.calls.map(c => c[0])).toEqual(["/", "/proc/self/fd/21/storage", "/proc/self/fd/22/runs", "/proc/self/fd/23/id", "/proc/self/fd/24/log"]);
    for (const [, flags] of opened.mock.calls) expect((flags as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    for (const dir of dirs) expect(dir.close).toHaveBeenCalledOnce();
    expect(file.close).not.toHaveBeenCalled();
  });
  it("closes pinned directories on a Linux symlink failure, without an unguarded fallback", async () => {
    const root = handle(21), storage = handle(22);
    const failure = Object.assign(new Error("link encountered"), { code: "ELOOP" });
    const opened = vi.spyOn(files, "open").mockResolvedValueOnce(root).mockResolvedValueOnce(storage).mockRejectedValueOnce(failure);
    await expect(openRunFile("/storage/runs/id/log", "linux")).rejects.toBe(failure);
    expect(opened).toHaveBeenCalledTimes(3);
    expect(root.close).toHaveBeenCalledOnce(); expect(storage.close).toHaveBeenCalledOnce();
  });
  it("refuses Darwin kernels predating the all-component guard", async () => {
    const opened = vi.spyOn(files, "open");
    await expect(openRunFile("/storage/runs/id/log", "darwin", "19.0.0")).rejects.toMatchObject({ code: "EUNSAFEPATH" });
    expect(opened).not.toHaveBeenCalled();
  });
  it("refuses unsupported platforms without opening data", async () => {
    const opened = vi.spyOn(files, "open");
    await expect(openRunFile("/storage/runs/id/log", "freebsd")).rejects.toMatchObject({ code: "EUNSAFEPATH" });
    expect(opened).not.toHaveBeenCalled();
  });
  it.each(['C:\\runs\\log:stream', '\\\\?\\C:\\runs\\log', '\\\\.\\pipe\\log', 'C:\\NUL.txt', 'C:\\runs\\..\\log', 'C:\\runs\\log.', 'C:\\runs\\log ', 'C:log'])('rejects unsafe Windows syntax before starting a helper: %s', async file => {
    await expect(openRunFile(file, 'win32')).rejects.toMatchObject({ code: 'EUNSAFEPATH' });
  });
});
