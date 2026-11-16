// Public installation files never fall through to the dashboard's SPA entry point.
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";

/** Use the routed path for both the access exception and the static fallback boundary, without another decode. */
export function isPublicFile(path: string): boolean {
  return path === "/manifest.webmanifest" || path === "/sw.js" || path.startsWith("/icons/");
}

/** Mounted after the access guard and API routes; root is injectable for isolated missing-file tests. */
export function dashboardFiles(root: string): Hono {
  const app = new Hono();
  app.use("*", serveStatic({ root: root.replaceAll("\\", "/") }));
  // Includes rejected encodings: the adapter must not serve a differently decoded path, nor may we serve the SPA.
  app.use("*", async (c, next) => isPublicFile(c.req.path) ? c.notFound() : next());
  app.get("*", serveStatic({ path: join(root, "index.html").replaceAll("\\", "/") }));
  return app;
}
