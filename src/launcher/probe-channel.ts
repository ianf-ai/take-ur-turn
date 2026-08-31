/**
 * Out-of-band client for the birth-time delivery probe relay.
 *
 * The foreground Agent owns the pane's stdin after birth.  This channel never
 * writes to that stdin: it sends a marker over a local Unix socket (or a
 * Windows named pipe) to the relay process that was started beside the Agent.
 * The relay runs the dialect-specific shell command with stdin ignored and
 * inherits the pane stdout, so the marker observed by `pane read` is command
 * output rather than a second TUI input.
 */

import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeliveryProbeDispatch } from "./delivery.js";

const MARKER = /^TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u;

export interface DeliveryProbeChannel {
  send(marker: string): Promise<DeliveryProbeDispatch>;
}

export interface DeliveryProbeChannelOptions {
  endpoint: string;
  /** Connection timeout; probe failure remains a non-fatal delivery result. */
  timeoutMs?: number;
}

/**
 * Derive the stable relay endpoint shared by a birth and later same-role
 * continuation launches.  The task/role values never enter a shell command;
 * only their SHA-256 basename is used as a filesystem/pipe identifier.
 */
export function deliveryProbeEndpoint(
  taskId: string,
  role: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // macOS caps AF_UNIX sun_path at 104 bytes; $TMPDIR (/var/folders/...)
  // plus a 32-hex digest overflowed it (106 chars), making probe-runner's
  // listen() fail and the pane fall back to a bare shell. 12 hex chars
  // keep the endpoint under every platform's limit while staying
  // collision-safe for realistic task counts.
  const digest = createHash("sha256").update(`${taskId}\u0000${role}`, "utf8").digest("hex").slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\tut-delivery-${digest}`;
  const configured = environment.TUT_DELIVERY_PROBE_DIR;
  const directory = configured !== undefined && configured.length > 0
    ? configured
    : "/tmp";
  return path.join(directory, `tut-probe-${digest}.sock`);
}

function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE" || code === "ENOTSOCK";
}

function finishSocket(
  socket: Socket,
  resolve: (value: DeliveryProbeDispatch) => void,
  value: DeliveryProbeDispatch,
  settled: { value: boolean },
): void {
  if (settled.value) return;
  settled.value = true;
  socket.destroy();
  resolve(value);
}

/** Build a one-request-per-connection relay client. */
export function createDeliveryProbeChannel(options: DeliveryProbeChannelOptions): DeliveryProbeChannel {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 1000);
  return {
    send(marker) {
      if (!MARKER.test(marker)) return Promise.resolve("failed");
      return new Promise<DeliveryProbeDispatch>((resolve) => {
        const settled = { value: false };
        let socket: Socket;
        try {
          socket = createConnection(options.endpoint);
        } catch (error) {
          resolve(isUnavailable(error) ? "unavailable" : "failed");
          return;
        }
        let response = "";
        let connected = false;
        const complete = (value: DeliveryProbeDispatch): void => finishSocket(socket, resolve, value, settled);
        socket.setEncoding("utf8");
        socket.setTimeout(timeoutMs, () => complete(connected ? "failed" : "unavailable"));
        socket.once("connect", () => {
          connected = true;
          // The relay protocol is an explicit request-response frame: one
          // validated marker line in (no command text or shell syntax ever
          // crosses this boundary), one `ok`/`failed` line back. The frame is
          // delimited by the newline, NOT by a half-close: Windows named pipes
          // do not honour AF_UNIX half-close semantics — an early end() tears
          // down the whole pipe before the acknowledgement can be written —
          // so the client keeps its write side open until the reply arrives.
          socket.write(`${marker}\n`);
        });
        socket.on("data", (chunk: string | Buffer) => {
          response += chunk.toString();
          if (response.includes("\n")) complete(response.trim() === "ok" ? "sent" : "failed");
        });
        socket.once("error", () => complete(
          !connected && response.length === 0 ? "unavailable" : "failed",
        ));
        socket.once("end", () => complete(response.trim() === "ok" ? "sent" : connected ? "failed" : "unavailable"));
        socket.once("close", () => {
          if (!settled.value) complete(response.trim() === "ok" ? "sent" : connected ? "failed" : "unavailable");
        });
      });
    },
  };
}
