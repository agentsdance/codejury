// A checkbox picker for `jury agents jury`, on Node's readline alone.
//
// The key handling is a pure function of (state, key) so it can be tested
// without a terminal; `pick` only wires it to raw-mode stdin and redraws.
import readline from "node:readline";

/**
 * Apply one keypress. Returns the next state; `done` is "save" or "cancel"
 * once the picker should close. Saving nothing is refused rather than
 * accepted, because an empty default jury is a run that cannot start.
 */
export function pickerKey(state, key = {}) {
  const { items, cursor, selected } = state;
  const next = { ...state, error: "" };
  if ((key.ctrl && key.name === "c") || key.name === "escape" || key.name === "q") return { ...next, done: "cancel" };
  if (key.name === "up" || key.name === "k") return { ...next, cursor: (cursor - 1 + items.length) % items.length };
  if (key.name === "down" || key.name === "j") return { ...next, cursor: (cursor + 1) % items.length };
  if (key.name === "space") {
    const set = new Set(selected);
    const name = items[cursor].name;
    if (set.has(name)) set.delete(name); else set.add(name);
    return { ...next, selected: [...set] };
  }
  if (key.name === "return" || key.name === "enter") {
    if (!selected.length) return { ...next, error: "Select at least one reviewer." };
    return { ...next, done: "save" };
  }
  return next;
}

export function pickerState(items, selected) {
  return { items, cursor: 0, selected: items.map(i => i.name).filter(n => selected.includes(n)), error: "", done: null };
}

export function renderPicker(state, title) {
  const width = Math.max(...state.items.map(i => i.name.length), 4) + 2;
  const lines = [`${title}  (space: toggle, enter: save, esc: cancel)`];
  state.items.forEach((item, i) => {
    const mark = state.selected.includes(item.name) ? "[x]" : "[ ]";
    const pointer = i === state.cursor ? ">" : " ";
    const notes = item.notes?.length ? `  ${item.notes.join(", ")}` : "";
    lines.push(`${pointer} ${mark} ${item.name.padEnd(width)}${item.status.padEnd(8)}${notes}`.trimEnd());
  });
  if (state.error) lines.push(state.error);
  return lines;
}

/** Run the picker on a TTY. Resolves with the chosen names, or null on cancel. */
export function pick(items, selected, { title, input = process.stdin, output = process.stdout } = {}) {
  let state = pickerState(items, selected);
  let drawn = 0;
  const draw = () => {
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = renderPicker(state, title);
    output.write(lines.join("\n") + "\n");
    drawn = lines.length;
  };
  return new Promise(resolve => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    const onKey = (_str, key) => {
      state = pickerKey(state, key);
      draw();
      if (!state.done) return;
      input.off("keypress", onKey);
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
      resolve(state.done === "save" ? state.selected : null);
    };
    input.on("keypress", onKey);
    draw();
  });
}
