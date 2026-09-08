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
import path from "node:path";
import type { DeliveryProbeDispatch } from "./delivery.js";

const MARKER = /^TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u;

/** Strictest common AF_UNIX sun_path limit (macOS 104, Linux 108) — the
 *  guard keeps every derived POSIX endpoint safely under it.  The limit is
 *  a BYTE limit (sun_path is a raw byte array), so every length check on an
 *  endpoint must count UTF-8 bytes, not JS characters — a non-ASCII
 *  TUT_DELIVERY_PROBE_DIR can be under the limit in characters yet overflow
 *  it in bytes. */
export const ENDPOINT_PATH_MAX = 104;

/** UTF-8 byte length of an endpoint path — the unit of the sun_path guard. */
export function endpointPathBytes(endpoint: string): number {
  return Buffer.byteLength(endpoint, "utf8");
}

export interface DeliveryProbeChannel {
  send(marker: string): Promise<DeliveryProbeDispatch>;
}

export interface DeliveryProbeChannelOptions {
  endpoint: string;
  /** Connection timeout; probe failure remains a non-fatal delivery result. */
  timeoutMs?: number;
}

/** The per-user discriminator mixed into the endpoint digest: a
 *  shared machine's sticky /tmp keeps another user's socket file
 *  un-unlinkable (EPERM) — different users must never derive the same
 *  endpoint.  Windows pipes carry no uid; the instance discriminator below
 *  does the disambiguation there. */
function endpointUid(platform: NodeJS.Platform): string {
  if (platform === "win32" || typeof process.getuid !== "function") return "";
  return String(process.getuid());
}

/**
 * Derive the relay endpoint shared by a birth and later same-role
 * continuation launches.  The task/role/uid/instance values never enter a
 * shell command; only their SHA-256 basename is used as a filesystem/pipe
 * identifier.  The digest mixes in the OS uid (sticky /tmp EPERM across
 * users) and — when known — the hub instance root: the same task id
 * living in two independent hubs (two checkouts with their own
 * `.context-hub`) would otherwise share one endpoint, and the newer relay
 * would steal it or — on Windows named pipes — split marker traffic into
 * the WRONG pane.  POSIX paths are length-guarded: a long
 * `TUT_DELIVERY_PROBE_DIR` used to overflow sun_path at listen() time
 * inside the pane, burning the whole delivery budget before anyone
 * noticed; the guard falls back to /tmp and raises HERE — at planning time,
 * loudly — if even that cannot fit.
 */
export function deliveryProbeEndpoint(
  taskId: string,
  role: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  /** Instance discriminator (the hub root); omit when unknown. */
  instance?: string,
): string {
  const digest = createHash("sha256")
    .update(`${taskId}\u0000${role}\u0000${endpointUid(platform)}\u0000${instance ?? ""}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\tut-delivery-${digest}`;
  const configured = environment.TUT_DELIVERY_PROBE_DIR;
  const directory = configured !== undefined && configured.length > 0
    ? configured
    : "/tmp";
  const endpoint = path.join(directory, `tut-probe-${digest}.sock`);
  if (endpointPathBytes(endpoint) > ENDPOINT_PATH_MAX) {
    const fallback = path.join("/tmp", `tut-probe-${digest}.sock`);
    if (endpointPathBytes(fallback) > ENDPOINT_PATH_MAX) {
      throw new Error(
        `delivery probe endpoint exceeds the AF_UNIX sun_path limit (${ENDPOINT_PATH_MAX} bytes) even under /tmp: ${fallback}`,
      );
    }
    return fallback;
  }
  return endpoint;
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
