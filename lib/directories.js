// One directory policy for every command. An explicit path wins; an empty path
// or an unsuitable implicit cwd falls back to ~/.jury and creates it.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function expandDirectory(value, { cwd = process.cwd(), home = homedir() } = {}) {
  const raw = String(value ?? "").trim();
  if (raw === "~") return home;
  if (/^~[\\/]/.test(raw)) return path.join(home, raw.slice(2));
  return path.resolve(cwd, raw);
}

export async function resolveJuryDirectory(
  value,
  { cwd = process.cwd(), home = homedir(), isUsable = async () => true } = {},
) {
  if (typeof value === "string" && value.trim()) {
    return expandDirectory(value, { cwd, home });
  }

  if (value === undefined && await isUsable(cwd)) return path.resolve(cwd);

  const fallback = path.join(home, ".jury");
  await mkdir(fallback, { recursive: true });
  return fallback;
}
