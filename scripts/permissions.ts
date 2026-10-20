/**
 * Builds permissions.json from src/catalog.json: each featured app's actions
 * as their permission names, titles and kinds, for apps that let people set
 * permissions per action (Otto ships a copy). Run after the catalog or the
 * kinds change; prepublish runs it too.
 *
 *   bun scripts/permissions.ts
 */
import { writeFile } from "node:fs/promises";
import catalog from "../src/catalog.json" with { type: "json" };
import { kindOf } from "../src/kinds";
import pkg from "../package.json" with { type: "json" };

const shortName = (app: string, slug: string) => (slug.startsWith(`${app.toUpperCase()}_`) ? slug.slice(app.length + 1) : slug).toLowerCase();

const apps: Record<string, { name: string; actions: [permission: string, title: string][] }> = {};
for (const [app, { name, actions }] of Object.entries(catalog as Record<string, { name: string; actions: { slug: string; title: string }[] }>)) {
  apps[app] = { name, actions: actions.map((a) => [`composio.${app}.${kindOf(a.slug, app)}.${shortName(app, a.slug)}`, a.title]) };
}
await writeFile(new URL("../permissions.json", import.meta.url), JSON.stringify({ version: pkg.version, apps }) + "\n");
console.log(Object.entries(apps).map(([app, a]) => `${app}: ${a.actions.length}`).join(", "));
