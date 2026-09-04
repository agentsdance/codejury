import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expandDirectory, resolveJuryDirectory } from "../lib/directories.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "jury-dir-"));

test("an empty --dir creates and resolves to ~/.jury", async () => {
  const home = await tmp();
  const cwd = await tmp();
  const resolved = await resolveJuryDirectory("", { home, cwd, isUsable: async () => true });
  assert.equal(resolved, path.join(home, ".jury"));
  await access(resolved);
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("a missing --dir uses cwd when it is usable", async () => {
  const home = await tmp();
  const cwd = await tmp();
  const resolved = await resolveJuryDirectory(undefined, { home, cwd, isUsable: async () => true });
  assert.equal(resolved, cwd);
  await assert.rejects(() => access(path.join(home, ".jury")));
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("a missing --dir falls back when cwd is unsuitable", async () => {
  const home = await tmp();
  const cwd = await tmp();
  const resolved = await resolveJuryDirectory(undefined, { home, cwd, isUsable: async () => false });
  assert.equal(resolved, path.join(home, ".jury"));
  await access(resolved);
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("an explicit directory wins and tilde paths expand consistently", async () => {
  const home = await tmp();
  const cwd = await tmp();
  assert.equal(
    await resolveJuryDirectory("state", { home, cwd, isUsable: async () => false }),
    path.join(cwd, "state"),
  );
  assert.equal(expandDirectory("~/state", { home, cwd }), path.join(home, "state"));
  assert.equal(expandDirectory("~", { home, cwd }), home);
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});
