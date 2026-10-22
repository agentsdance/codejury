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

export function languageInstruction(value) {
  const language = normalizeLanguage(value);
  if (!language) return "";
  return `\n\nResponse language: ${language}.
Use this language for all generated prose: review findings and summaries, judge
reasons and evidence, replies to comments, and explanations of code fixes. This
preference overrides earlier language preferences and the language of quoted comments.
Preserve programming syntax, identifiers, existing code conventions, JSON keys,
verdict enum values, FINDING: and WHERE: headers, and the exact configured stop marker.
`;
}
