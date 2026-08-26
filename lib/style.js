// Colour and shape for the CLI's own output.
//
// A round prints for pages, and every line used to arrive at the same weight:
// a round boundary, a reviewer's raw report and a triage verdict were
// indistinguishable while scrolling. Colour is used only where it carries
// meaning — whose turn it is, and how a finding was settled — and never as
// decoration.

/**
 * Colour is off unless stdout is a terminal that wants it.
 *
 * `NO_COLOR` is honoured for any value at all, per no-color.org: the variable
 * existing is the signal. A pipe or a file gets plain text, so `cr … > log`
 * and `| grep` stay readable.
 */
const ON = process.env.NO_COLOR === undefined
  && process.env.TERM !== "dumb"
  && process.stdout.isTTY === true;

const ESC = "\x1b[";
const wrap = (open, close) => (s) => (ON ? `${ESC}${open}m${s}${ESC}${close}m` : String(s));

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const under = wrap(4, 24);

// 256-colour, so the palette matches the console's hues rather than whatever
// the terminal theme maps the 8 basic colours to.
const fg = (n) => wrap(`38;5;${n}`, 39);

export const ok = fg(71);      // green — accepted, converged
export const bad = fg(167);    // red — rejected, failed to run
export const warn = fg(179);   // amber — deferred, still open
export const info = fg(74);    // blue — headings, structural
export const muted = fg(245);  // grey — timings, paths, detail

/** The console assigns each agent a hue; the CLI uses the same ones. */
const AGENT_HUE = {
  claude: 176, codex: 250, grok: 66, agy: 74, droid: 209,
};

/** Stable per name, so an unconfigured agent still reads as itself. */
export function agent(name) {
  if (!ON) return String(name);
  let n = AGENT_HUE[name];
  if (n === undefined) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    // 22..219 avoids the near-black and near-white ends of the cube, both of
    // which vanish into one terminal background or the other.
    n = 22 + (Math.abs(h) % 198);
  }
  return fg(n)(name);
}

const VERDICT_COLOUR = { accepted: ok, rejected: bad, deferred: warn, superseded: muted };

/** accepted / rejected / deferred in the three colours the web view uses. */
export function verdict(v) {
  return (VERDICT_COLOUR[v] ?? muted)(String(v).toUpperCase());
}

/**
 * "1 finding" / "2 findings", rather than the "(s)" placeholder that leaked
 * into the output and stayed there.
 */
export function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** A labelled line in the run header: dim key, plain value. */
export function field(key, value) {
  return `${dim(key.padEnd(8))} ${value}`;
}

/**
 * A rule that says what follows it. Reviewer reports are dumped whole, and
 * without a marked boundary one runs straight into the triage below it.
 */
export function rule(label, width = 64) {
  const text = label ? ` ${label} ` : "";
  const dashes = Math.max(0, width - text.length);
  const left = Math.min(3, dashes);
  return dim("─".repeat(left)) + bold(text) + dim("─".repeat(dashes - left));
}

/** Indent every line of a block, so a pasted report is visibly not our voice. */
export function indent(text, prefix = "  ") {
  return String(text).replace(/^/gm, prefix);
}
