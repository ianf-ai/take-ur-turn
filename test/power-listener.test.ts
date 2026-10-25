import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, readlink } from "node:fs/promises";
import { listenerPid } from "../src/standalone/power/listener.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), readdir: vi.fn(), readlink: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.resetAllMocks(); });

// /proc boundary fixtures let macOS CI exercise Linux socket ownership. Include
// non-listening connections, unrelated ports, shared descriptors and hidden owners.
function procFixture(owners: Record<string, string[] | null>, tcp: string, tcp6 = "header\n"): void {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.mocked(readFile).mockImplementation(async file => {
    if (file === "/proc/net/tcp") return tcp;
    if (file === "/proc/net/tcp6") return tcp6;
    throw new Error(`unexpected read: ${String(file)}`);
  });
  vi.mocked(readdir).mockImplementation((async (dir: unknown) => {
    if (dir === "/proc") return [...Object.keys(owners), "self", "net"];
    const pid = String(dir).split("/")[2]!;
    if (!owners[pid]) throw new Error("EACCES");
    return owners[pid]!.map((_, index) => String(index));
  }) as typeof readdir);
  vi.mocked(readlink).mockImplementation(async file => {
    const parts = String(file).split("/");
    return owners[parts[2]!]![Number(parts[4])]!;
  });
}

const listening = (port: string, inode: string, state = "0A") =>
  `0: 0100007F:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}\n`;

describe("Linux listener attribution", () => {
  it("finds the sole owner, deduplicates its FDs, and ignores other ports and established connections", async () => {
    procFixture({ "100": ["socket:[42]", "socket:[42]", "/tmp/log"], "200": ["socket:[43]", "socket:[44]"] },
      "header\n" + listening("0BB9", "42") + listening("0BBA", "43") + listening("0BB9", "44", "01"));
    expect(await listenerPid(3001)).toBe(100);
  });

  it("refuses a socket shared between processes, even when the port has one inode", async () => {
    procFixture({ "100": ["socket:[42]"], "200": ["socket:[42]"] }, "header\n" + listening("0BB9", "42"));
    await expect(listenerPid(3001)).rejects.toThrow("unique listener PID");
  });

  it("refuses a second IPv6 listener whose owner cannot be read", async () => {
    procFixture({ "100": ["socket:[42]"], "200": null }, "header\n" + listening("0BB9", "42"),
      "header\n" + listening("0BB9", "43"));
    await expect(listenerPid(3001)).rejects.toThrow("some socket owners are unreadable or changed");
  });

  it("refuses an absent listener", async () => {
    procFixture({}, "header\n");
    await expect(listenerPid(3001)).rejects.toThrow("found none");
  });
});
