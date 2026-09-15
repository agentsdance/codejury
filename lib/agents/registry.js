// The built-in agent registry.
//
// Adding an agent is meant to be a one-file change: write <name>.json in this
// directory and add it to the list below. Nothing else in the codebase needs to
// know the new name — `jury agents`, `--reviewer`, `--judge` and the global
// judge setting all read from here.
//
// The import list is explicit rather than a directory scan because the package
// ships a fixed `files` list to npm and an agent that exists on disk but was
// never published would be a confusing way to fail.
import claude from "./claude.json" with { type: "json" };
import codex from "./codex.json" with { type: "json" };
import grok from "./grok.json" with { type: "json" };
import droid from "./droid.json" with { type: "json" };
import agy from "./agy.json" with { type: "json" };
import opencode from "./opencode.json" with { type: "json" };
import qwen from "./qwen.json" with { type: "json" };
import copilot from "./copilot.json" with { type: "json" };
import cursor from "./cursor.json" with { type: "json" };
import amp from "./amp.json" with { type: "json" };
import kimi from "./kimi.json" with { type: "json" };

/**
 * Every built-in agent, in the order `jury agents` lists them. Judge first,
 * then the reviewers that shipped earliest — the order is cosmetic, but a
 * stable one keeps the output diffable between runs.
 */
export const BUILTIN_AGENTS = [
  codex,
  claude,
  grok,
  droid,
  agy,
  opencode,
  qwen,
  copilot,
  cursor,
  amp,
  kimi,
];
