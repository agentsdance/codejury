import { parseArgs } from "node:util";

/** Accept --web, --web=true/false, and --web true/false without eating a PR URL. */
export function parseReviewArgs(args, options) {
  const { tokens } = parseArgs({ args, options: { ...options, web: { type: "boolean" } },
    allowPositionals: true, strict: false, tokens: true });
  const normalized = [...args];
  for (const token of tokens) {
    if (token.kind !== "option" || token.name !== "web" || token.inlineValue) continue;
    const next = tokens.find((t) => t.index === token.index + 1);
    if (next?.kind === "positional" && ["true", "false"].includes(next.value)) continue;
    normalized[token.index] = "--web=true";
  }
  const parsed = parseArgs({ args: normalized, allowPositionals: true,
    options: { ...options, web: { type: "string", default: "true" } } });
  if (!["true", "false"].includes(parsed.values.web)) {
    throw new Error("--web must be true or false");
  }
  parsed.values.web = parsed.values.web === "true";
  return parsed;
}
