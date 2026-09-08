import { parseArgs } from "node:util";

/** Accept default-on boolean flags with optional true/false values. */
export function parseReviewArgs(args, options) {
  const { tokens } = parseArgs({ args, options: { ...options, web: { type: "boolean" }, push: { type: "boolean" } },
    allowPositionals: true, strict: false, tokens: true });
  const normalized = [...args];
  for (const token of tokens) {
    if (token.kind !== "option" || !["web", "push"].includes(token.name) || token.inlineValue) continue;
    const next = tokens.find((t) => t.index === token.index + 1);
    if (next?.kind === "positional" && ["true", "false"].includes(next.value)) continue;
    normalized[token.index] = `--${token.name}=true`;
  }
  const parsed = parseArgs({ args: normalized, allowPositionals: true,
    options: { ...options, web: { type: "string", default: "true" }, push: { type: "string", default: "true" } } });
  for (const name of ["web", "push"]) {
    if (!["true", "false"].includes(parsed.values[name])) throw new Error(`--${name} must be true or false`);
    parsed.values[name] = parsed.values[name] === "true";
  }
  return parsed;
}
