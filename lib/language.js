/** Validate and canonicalize a prose-language preference, never prompt text. */
export function normalizeLanguage(value) {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || !value || value.length > 128) throw new Error();
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    throw new Error("--language must be a valid language tag, for example en or zh-CN");
  }
}

// Explicit language updates survive concurrent writes of older run snapshots.
// Older runs without these events still read the preference from their target.
export function languageIn(events) {
  const changed = events.findLast(e => e.t === "language.changed");
  return changed ? changed.language
    : events.findLast(e => e.t === "target" && e.target?.language !== undefined)?.target.language;
}

export function languageInstruction(value) {
  const language = normalizeLanguage(value);
  if (!language) return "";
  return `\n\nResponse language: ${language}.
Use this language for responses: review findings and summaries, judge
reasons and evidence, replies to comments, and explanations of code fixes. This
preference overrides earlier language preferences and the language of quoted comments.
Follow repository conventions and task requirements for code comments, string
literals and test names; the response language does not override them.
Preserve programming syntax, identifiers, existing code conventions, JSON keys,
verdict enum values, FINDING: and WHERE: headers, and the exact configured stop marker.
`;
}
