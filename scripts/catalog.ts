/**
 * Builds src/catalog.json: every action of the featured apps, with the plain
 * title Composio's docs give it. A consumer key can't list an app's actions,
 * but the public docs do, one Markdown page per app.
 *
 *   bun scripts/catalog.ts
 */
import { writeFile } from "node:fs/promises";

const APPS: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  slack: "Slack",
  notion: "Notion",
  github: "GitHub",
  linear: "Linear",
  outlook: "Outlook",
};

type Entry = { slug: string; title: string };

async function actions(app: string): Promise<Entry[]> {
  const res = await fetch(`https://docs.composio.dev/toolkits/${app}.md`);
  if (!res.ok) throw new Error(`${app}: docs answered ${res.status}`);
  const md = await res.text();
  // Only the "## Tools" section: triggers and FAQs follow it.
  const start = md.indexOf("\n## Tools\n");
  if (start < 0) throw new Error(`${app}: no Tools section`);
  const end = md.indexOf("\n## ", start + 10);
  const section = md.slice(start, end < 0 ? undefined : end);
  const out: Entry[] = [];
  let title = "";
  for (const line of section.split("\n")) {
    const h = /^### (.+)$/.exec(line);
    if (h) title = h[1].trim();
    const s = /^\*\*Slug:\*\* `([A-Z0-9_]+)`/.exec(line);
    if (s && title) {
      out.push({ slug: s[1], title });
      title = "";
    }
  }
  if (!out.length) throw new Error(`${app}: found no actions`);
  return out;
}

const catalog: Record<string, { name: string; actions: Entry[] }> = {};
for (const [app, name] of Object.entries(APPS)) {
  catalog[app] = { name, actions: await actions(app) };
  console.log(`${name}: ${catalog[app].actions.length} actions`);
}
await writeFile(new URL("../src/catalog.json", import.meta.url), JSON.stringify(catalog, null, 1) + "\n");
