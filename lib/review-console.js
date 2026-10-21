import path from "node:path";
import { serve } from "./server.js";
import { appendEvent, publishEvents } from "./store.js";

/** Publish the selected run before the server can answer the browser's first request. */
export async function startReviewConsole({ dir, target, cwd, port, onLog }, serveConsole = serve) {
  await appendEvent(dir, { t: "target", target: { ...target, stateNote: "starting review" } });
  await publishEvents(dir, { target });
  const { url } = await serveConsole({ port, cwd, onLog });
  const currentRunUrl = new URL(url);
  currentRunUrl.searchParams.set("run", path.basename(dir));
  return currentRunUrl.href;
}
