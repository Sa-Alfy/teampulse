// Self-host Worker entry: a thin adapter over the pure core in selfhost/core/.

import { error, log } from "./http.js";
import { ingest, events, health } from "./routes.js";
import { webhook } from "./telegram.js";
import { runCron } from "./cron.js";

const ROUTES = {
  "/api/ingest": { POST: ingest },
  "/api/events": { GET: events },
  "/health": { GET: health },
  "/telegram/webhook": { POST: webhook },
};

/** Exported for tests: `now` is a parameter, never read inside the handlers. */
export async function handle(request, env, now, ctx) {
  const url = new URL(request.url);
  if (url.protocol !== "https:") return error(403, "https_required");
  const route = ROUTES[url.pathname];
  if (!route) return error(404, "not_found");
  const fn = route[request.method];
  if (!fn) return error(405, "method_not_allowed");
  try {
    return await fn(request, env, now, ctx);
  } catch (e) {
    // Error names only: messages can carry SQL or input fragments.
    log({ route: url.pathname, status: 500, err: e && e.name ? String(e.name) : "Error" });
    return error(500, "internal");
  }
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, Date.now(), ctx);
  },
  async scheduled(controller, env) {
    try {
      await runCron(env, controller.scheduledTime || Date.now());
    } catch (e) {
      log({ route: "cron", status: 500, err: e && e.name ? String(e.name) : "Error" });
    }
  },
};
