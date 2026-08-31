/**
 * Channel abstraction.
 *
 * The interface below is the frozen surface; this module is the ONLY thing
 * notifier.ts consumes for output. Two channels:
 *
 *   desktop — Windows PowerShell/WinRT toast → terminal bell, or on POSIX the
 *             existing macOS osascript → Linux notify-send → terminal bell
 *             degradation chain. Never throws.
 *   webhook — POST {title, body, task_id} as JSON to webhook_url (Feishu/
 *             Telegram-generic), 5s timeout, failures logged not thrown.
 *
 * createChannels interprets the /state `notify` value; missing/corrupt config
 * falls back to ["desktop"] so a non-empty Channel[] is always returned.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { psq } from "./launcher/shell-renderer.js";

export interface Notification {
  title: string;
  body: string;
  task_id?: string;
}

export interface Channel {
  name: string;
  send(msg: Notification): Promise<void>;
}

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 5000;

/**
 * Constant AppleScript source: title/body NEVER enter script source —
 * they are passed as argv after "--" and reach the script via `item N of argv`
 * as plain strings. Interpolating text into the `-e` source was a command
 * injection vector (`" & (do shell script "...") & "` executed arbitrary
 * commands); with argv there is nothing to escape.
 */
const OSASCRIPT_NOTIFY_SOURCE = 'on run argv\n  display notification (item 1 of argv) with title (item 2 of argv)\nend run';

const WINDOWS_TOAST_APP_ID = "TUT.Notifier";
const WINDOWS_TOAST_DISPLAY_NAME = "TUT Notifier";

/**
 * Windows toast text must pass psq, whose raw-input contract rejects NUL/CR/LF
 * (src/launcher/shell-renderer.ts). Letting that throw here degraded the whole
 * toast to a silent bell: notification text — task titles included —
 * legitimately carries newlines, so every such message was lost without a
 * trace on Windows only. Fold every CR/LF run (LF-LF, CR-CR, mixed CRLF-LF…)
 * into exactly one space and drop NULs before quoting instead, with one
 * accurate warning per distinct transformation so the content change is never
 * silent and never misdescribed.
 */
function foldForWindowsToast(field: "title" | "body", value: string): string {
  const noNewlines = value.replace(/[\r\n]+/gu, " ");
  const cleaned = noNewlines.replaceAll("\u0000", "");
  if (noNewlines !== value) {
    warn(`windows toast: folded newlines in notification ${field} into spaces`);
  }
  if (cleaned !== noNewlines) {
    warn(`windows toast: dropped NUL bytes from notification ${field}`);
  }
  return cleaned;
}

/**
 * Build the PowerShell script used by the Windows desktop channel.
 *
 * Message values are deliberately inserted only as PowerShell single-quoted
 * literals (folded first — see foldForWindowsToast). psq doubles embedded
 * apostrophes, so notification text cannot terminate the literal or add
 * PowerShell code. SecurityElement.Escape then makes the resulting values safe
 * as XML text before Windows parses the toast document.
 */
export function buildWindowsToastPowerShellScript(msg: Notification): string {
  const title = psq(foldForWindowsToast("title", msg.title));
  const body = psq(foldForWindowsToast("body", msg.body));
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `$appId = ${psq(WINDOWS_TOAST_APP_ID)}`,
    "$registrationPath = Join-Path 'HKCU:\\Software\\Classes\\AppUserModelId' $appId",
    "New-Item -Path $registrationPath -Force | Out-Null",
    `Set-ItemProperty -Path $registrationPath -Name 'DisplayName' -Value ${psq(WINDOWS_TOAST_DISPLAY_NAME)}`,
    "$iconUri = Join-Path $PSHOME 'powershell.exe'",
    "Set-ItemProperty -Path $registrationPath -Name 'IconUri' -Value $iconUri",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    `$title = [System.Security.SecurityElement]::Escape(${title})`,
    `$body = [System.Security.SecurityElement]::Escape(${body})`,
    "$xmlText = \"<?xml version='1.0' encoding='utf-8'?><toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>\"",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml($xmlText)",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\$appId).Show(\$toast)",
    "exit 0",
    "} catch {",
    "exit 1",
    "}",
  ].join("\n");
}

export interface ChannelFactoryOptions {
  /** Platform override used by tests; production defaults to process.platform. */
  platform?: NodeJS.Platform;
}

function warn(line: string): void {
  process.stderr.write(`tut: warning: ${line}\n`);
}

// --- desktop ------------------------------------------------------------------

function ringBell(): void {
  try {
    process.stderr.write("\u0007");
  } catch {
    // never throws
  }
}

function createDesktopChannel(platform: NodeJS.Platform): Channel {
  return {
    name: "desktop",
    async send(msg: Notification): Promise<void> {
      // Windows has a native PowerShell/WinRT path. Do not probe the POSIX
      // tools there: a missing PowerShell installation has the same terminal
      // bell fallback as any other desktop-notification failure.
      if (platform === "win32") {
        try {
          await execFileAsync(
            "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", buildWindowsToastPowerShellScript(msg)],
            { timeout: EXEC_TIMEOUT_MS },
          );
          return;
        } catch {
          ringBell();
          return;
        }
      }

      // Chain position 1: macOS osascript. On non-macOS hosts exec fails with
      // ENOENT and the chain simply falls through. Message text rides in argv
      // (never in script source) — no escaping, no injection surface.
      try {
        await execFileAsync(
          "osascript",
          ["-e", OSASCRIPT_NOTIFY_SOURCE, "--", msg.body, msg.title],
          { timeout: EXEC_TIMEOUT_MS },
        );
        return;
      } catch {
        // fall through to notify-send
      }
      // Chain position 2: Linux notify-send.
      try {
        await execFileAsync("notify-send", [msg.title, msg.body], { timeout: EXEC_TIMEOUT_MS });
        return;
      } catch {
        // fall through to bell
      }
      // Chain position 3: terminal bell — last resort, cannot meaningfully fail.
      ringBell();
    },
  };
}

// --- webhook --------------------------------------------------------------------

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

const WEBHOOK_TIMEOUT_MS = 5000;

function createWebhookChannel(url: string): Channel {
  return {
    name: "webhook",
    async send(msg: Notification): Promise<void> {
      const payload: { title: string; body: string; task_id?: string } = {
        title: msg.title,
        body: msg.body,
      };
      if (msg.task_id !== undefined) payload.task_id = msg.task_id;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) {
          warn(`webhook channel: POST ${url} → HTTP ${res.status}`);
        }
      } catch (e) {
        // Network error or 5s timeout — logged, never thrown (channel contract).
        warn(`webhook channel: POST ${url} failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// --- factory --------------------------------------------------------------------

interface NotifyConfigShape {
  channels: string[];
  webhook_url: unknown;
}

/** Parses the /state `notify` value; null when missing or structurally corrupt. */
function parseNotifyConfig(cfg: unknown): NotifyConfigShape | null {
  if (cfg === undefined || cfg === null) return null;
  if (typeof cfg !== "object") return null;
  const obj = cfg as { channels?: unknown; webhook_url?: unknown };
  if (!Array.isArray(obj.channels) || !obj.channels.every((c) => typeof c === "string")) return null;
  return { channels: obj.channels as string[], webhook_url: obj.webhook_url };
}

/**
 * Corrupt-config fingerprints already warned about: the notifier
 * rebuilds channels every poll, so a warning per poll would repeat forever —
 * warn ONCE per distinct config content instead.
 */
const warnedCorruptConfigs = new Set<string>();

/**
 * Builds channels from the /state `notify` config value.
 * Missing/corrupt config → fallback to ["desktop"]; desktop's own chain ends
 * at a terminal bell so a Channel[] is always returned. Unknown channel names
 * are skipped; "webhook" without a usable http(s) URL is skipped. Repeated
 * names are deduped (["desktop","desktop"] → one desktop). If nothing
 * usable remains, the desktop fallback applies.
 */
export function createChannels(notifyCfg: unknown, options: ChannelFactoryOptions = {}): Channel[] {
  const platform = options.platform ?? process.platform;
  const cfg = parseNotifyConfig(notifyCfg);
  const channels: Channel[] = [];
  if (cfg === null) {
    if (notifyCfg !== undefined && notifyCfg !== null) {
      const fingerprint = JSON.stringify(notifyCfg);
      if (!warnedCorruptConfigs.has(fingerprint)) {
        warnedCorruptConfigs.add(fingerprint);
        warn(`notify config is corrupt (${fingerprint.slice(0, 120)}); falling back to ["desktop"]`);
      }
    }
    // Missing key = the default, not a warning ("缺省/字段损坏 → 回退").
    return [createDesktopChannel(platform)];
  }
  const seen = new Set<string>();
  for (const name of cfg.channels) {
    if (seen.has(name)) continue; // dedupe: one channel per name
    seen.add(name);
    if (name === "desktop") {
      channels.push(createDesktopChannel(platform));
    } else if (name === "webhook") {
      if (isHttpUrl(cfg.webhook_url)) {
        channels.push(createWebhookChannel(cfg.webhook_url));
      } else {
        warn(`notify config lists "webhook" but webhook_url is missing or not http(s); skipping it`);
      }
    } else {
      warn(`notify config lists unknown channel "${name}"; skipping it`);
    }
  }
  if (channels.length === 0) {
    warn("notify config produced no usable channels; falling back to [\"desktop\"]");
    return [createDesktopChannel(platform)];
  }
  return channels;
}
