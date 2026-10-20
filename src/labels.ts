/**
 * Names for the ids an action carries, so an approval reads "Delete event
 * Team sync" rather than "Delete event 4f8a…". One quick lookup through the
 * same app, only for actions that change or delete something; if it's slow or
 * fails, the approval just goes without a name.
 */
import type { Client } from "./composio";

type Lookup = { params: string[]; slug: string; args: (id: string, args: Record<string, unknown>) => Record<string, unknown>; prefix?: string };

const LOOKUPS: Record<string, Lookup[]> = {
  gmail: [
    { params: ["message_id"], slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", args: (id) => ({ message_id: id, format: "metadata" }) },
    { params: ["thread_id"], slug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", args: (id) => ({ thread_id: id }) },
    { params: ["draft_id"], slug: "GMAIL_GET_DRAFT", args: (id) => ({ draft_id: id, format: "metadata" }) },
  ],
  googlecalendar: [{ params: ["event_id"], slug: "GOOGLECALENDAR_EVENTS_GET", args: (id, a) => ({ event_id: id, calendar_id: a.calendar_id ?? "primary" }) }],
  googledrive: [{ params: ["file_id", "fileId"], slug: "GOOGLEDRIVE_GET_FILE_METADATA", args: (id) => ({ fileId: id, fields: "name" }) }],
  googledocs: [{ params: ["document_id", "documentId", "id"], slug: "GOOGLEDOCS_GET_DOCUMENT_BY_ID", args: (id) => ({ id }) }],
  googlesheets: [{ params: ["spreadsheet_id", "spreadsheetId"], slug: "GOOGLESHEETS_GET_SPREADSHEET_INFO", args: (id) => ({ spreadsheet_id: id, fields: "properties.title" }) }],
  slack: [{ params: ["channel", "channel_id"], slug: "SLACK_RETRIEVE_CONVERSATION_INFORMATION", args: (id) => ({ channel: id }), prefix: "#" }],
  notion: [
    { params: ["page_id"], slug: "NOTION_RETRIEVE_PAGE", args: (id) => ({ page_id: id }) },
    { params: ["block_id"], slug: "NOTION_FETCH_BLOCK_METADATA", args: (id) => ({ block_id: id }) },
  ],
  linear: [{ params: ["issue_id", "issueId"], slug: "LINEAR_GET_LINEAR_ISSUE", args: (id) => ({ issue_id: id }) }],
  outlook: [
    { params: ["message_id"], slug: "OUTLOOK_GET_MESSAGE", args: (id) => ({ message_id: id, select: "subject" }) },
    { params: ["event_id"], slug: "OUTLOOK_GET_EVENT", args: (id) => ({ event_id: id }) },
  ],
};

/** Slack channel, DM and group ids; anything else is already a name. */
const SLACK_ID = /^[CDG][A-Z0-9]{6,}$/;
const WAIT = 2500;
const KEEP = 10 * 60_000;

/** The first title-ish string in a response: a subject, summary, name or title, Gmail's Subject header, Notion's rich text. */
function titleIn(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    const header = value.find((h) => h && typeof h === "object" && String((h as { name?: unknown }).name).toLowerCase() === "subject") as { value?: unknown } | undefined;
    if (typeof header?.value === "string" && header.value.trim()) return header.value;
    const text = value.map((t) => (t && typeof t === "object" ? (t as { plain_text?: unknown }).plain_text : undefined)).filter((t): t is string => typeof t === "string").join("");
    if (text.trim()) return text;
    for (const v of value) {
      const t = titleIn(v, depth + 1);
      if (t) return t;
    }
    return;
  }
  const o = value as Record<string, unknown>;
  for (const k of ["subject", "summary", "title", "name"]) {
    if (typeof o[k] === "string" && (o[k] as string).trim()) return o[k] as string;
  }
  for (const v of Object.values(o)) {
    const t = titleIn(v, depth + 1);
    if (t) return t;
  }
}

export function labeler(composio: Client) {
  const cache = new Map<string, { at: number; name?: string }>();

  async function nameOf(lookup: Lookup, id: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string | undefined> {
    const key = `${lookup.slug}:${id}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < KEEP) return hit.name;
    const data = await composio.run(lookup.slug, lookup.args(id, args), AbortSignal.any([signal, AbortSignal.timeout(WAIT)])).catch(() => undefined);
    const title = titleIn(data)?.trim().replace(/\s+/g, " ").slice(0, 100);
    const name = title && lookup.prefix && !title.startsWith(lookup.prefix) ? lookup.prefix + title : title;
    cache.set(key, { at: Date.now(), name });
    return name;
  }

  /** Readable names for the ids in these arguments, keyed by id. */
  return async function names(app: string, slug: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, string>> {
    const jobs: Promise<[string, string | undefined]>[] = [];
    for (const lookup of LOOKUPS[app] ?? []) {
      if (lookup.slug === slug) continue;
      const param = lookup.params.find((p) => typeof args[p] === "string" && args[p]);
      if (!param) continue;
      const id = args[param] as string;
      if (app === "slack" && !SLACK_ID.test(id)) continue;
      jobs.push(nameOf(lookup, id, args, signal).then((n) => [id, n]));
      break;
    }
    return Object.fromEntries((await Promise.all(jobs)).filter((e): e is [string, string] => !!e[1]));
  };
}
