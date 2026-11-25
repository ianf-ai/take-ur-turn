/** Self-identify TUT processes via process.title.
 *
 *  process.title is a POSIX-only identification surface: on macOS/Linux the
 *  setter rewrites what ps shows (comm/args), so services and run
 *  supervisors surface as tut-hub / tut-notify / tut-watcher /
 *  tut-run.<run_id>. On Windows the setter only updates the console title
 *  (SetConsoleTitleW plus an internal cache) and leaves the process command
 *  line untouched, so it reaches none of the surfaces TUT identifies by
 *  there — command-line rows and power.json. Setting it would gain
 *  nothing, hence the win32 no-op keeps Windows behavior exactly as
 *  before. */
export function setProcessTitle(title: string): void {
  if (process.platform === "win32") return;
  process.title = title;
}
