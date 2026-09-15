// Contrast is only meaningful between opaque colours: a translucent background
// composites over whatever is behind it, so its own channels say nothing about
// what the label actually sits on. Refuse rather than silently dropping alpha.
function channels(text) {
  const match = /^rgba?\(([^)]+)\)$/.exec(text);
  const parts = match?.[1].split(',').map(value => Number(value.trim()));
  if (!parts || ![3, 4].includes(parts.length) || !parts.every(Number.isFinite)
      || parts.slice(0, 3).some(value => value < 0 || value > 255)) {
    throw new Error(`Expected an RGB colour: ${text}`);
  }
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (alpha !== 1) throw new Error(`Colour must be opaque to judge contrast, got ${text}`);
  return parts.slice(0, 3);
}

// Opacity multiplies down the tree: a faded ancestor hides a node whose own
// computed colours stay fully opaque, so contrast alone cannot see the problem.
// Takes a style lookup so it runs both in the page and against a plain fake tree.
export function effectiveOpacity(node, styleOf) {
  let opacity = 1;
  for (let current = node; current; current = current.parentElement) opacity *= Number(styleOf(current).opacity);
  return opacity;
}

export function contrast(fg, bg) {
  const luminance = text => channels(text).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
