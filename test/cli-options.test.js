import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewArgs } from "../lib/cli-options.js";

const options = { title: { type: "string" }, rounds: { type: "string" } };
const parse = (args) => parseReviewArgs(args, options);
test("web defaults on and accepts explicit boolean values", () => {
  for (const args of [[], ["--web"], ["--web=true"], ["--web", "true"]]) {
    assert.equal(parse(args).values.web, true);
  }
  for (const args of [["--web=false"], ["--web", "false"]]) {
    assert.equal(parse(args).values.web, false);
  }
});
test("web preserves URLs, option values, and positional delimiters", () => {
  const url = "https://github.com/acme/repo/pull/1";
  for (const args of [["--web", url], [url, "--web"], ["--web=false", url]]) {
    assert.deepEqual(parse(args).positionals, [url]);
  }
  assert.equal(parse(["--title=--web", "--web=false"]).values.title, "--web");
  assert.deepEqual(parse(["--", "--web=false"]).positionals, ["--web=false"]);
  assert.throws(() => parse(["--web=maybe"]), /true or false/);
  assert.throws(() => parse(["--no-push"]), /Unknown option/);
});
