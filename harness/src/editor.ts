import { execFileSync, spawn, spawnSync } from "node:child_process";

// `/personality edit` (ADR-0053): open the file in the user's own editor. $VISUAL / $EDITOR win; otherwise the
// operating system's default (Notepad on Windows and under WSL, TextEdit on macOS, xdg-open on a Linux desktop),
// and nano or vi only when nothing else is there. The personality is read fresh every turn, so whatever is saved
// applies from the next message even when the editor does not make us wait for it.

/** Returns a line for the user. `waited` editors have closed by the time this returns. */
export function openInEditor(file: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const run = (cmd: string, args: string[]): string => {
    const r = spawnSync(cmd, args, { stdio: "inherit", env });
    if (r.error) throw new Error(`could not start ${cmd}: ${r.error.message}`);
    return "saved";
  };
  const detached = (cmd: string, args: string[]): string => {
    spawn(cmd, args, { stdio: "ignore", detached: true, env }).on("error", () => {}).unref();
    return `opened in your editor (${cmd}); save the file and it applies from your next message`;
  };

  const has = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore", env }).status === 0;
  const own = (env.VISUAL || env.EDITOR || "").trim();
  if (own) {
    // "code --wait" and the like: the first word is the program, the rest its arguments.
    const [cmd, ...args] = own.split(/\s+/);
    return run(cmd, [...args, file]);
  }
  if (platform === "win32") return run("notepad", [file]); // Notepad keeps us waiting until it closes
  if (platform === "darwin") return run("open", ["-W", "-t", file]); // TextEdit; -W waits for it to quit
  if (env.WSL_DISTRO_NAME && has("notepad.exe")) {
    try {
      return run("notepad.exe", [execFileSync("wslpath", ["-w", file], { encoding: "utf8" }).trim()]);
    } catch {
      /* fall through to the Linux choices */
    }
  }
  if ((env.DISPLAY || env.WAYLAND_DISPLAY) && has("xdg-open")) return detached("xdg-open", [file]);
  for (const cmd of ["nano", "vi"]) if (has(cmd)) return run(cmd, [file]);
  throw new Error(`no editor found: set EDITOR (e.g. EDITOR=nano), or edit ${file} yourself; it is read fresh every turn`);
}
