import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Leave five seconds of the web-launch test's 30-second timeout for teardown.
export async function waitForOpenReceipt(file, {
  timeout = 25000, now = Date.now, sleep = delay, read = readFile,
} = {}) {
  const deadline = now() + timeout;
  do {
    try { return JSON.parse(await read(file, "utf8")); }
    catch (error) {
      // The opener may still be starting or writing the receipt.
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await sleep(20);
  } while (now() < deadline);
  return undefined;
}
