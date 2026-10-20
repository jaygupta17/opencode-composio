/**
 * Who or what an action reaches: the recipients of an email, the guests of an
 * event, the people a file is shared with, the Slack channel, the GitHub repo.
 * These become the permission's resources, so a rule can say "allow mail to
 * *@acme.com, ask for anyone else", and "Always allow" remembers exactly that
 * person or place.
 */
const PEOPLE = [
  "recipient_email", "extra_recipients", "to", "cc", "bcc", "to_recipients", "cc_recipients", "bcc_recipients", "cc_emails", "bcc_emails",
  "attendees", "invitees", "guests", "emails", "email", "email_address", "emailAddress", "user_email", "user_emails", "users", "permissions",
];
const PLACES = ["channel", "channel_id", "channel_name", "channels", "channel_ids", "conversation_id"];

/** What an action is for when it reaches no one: an event with no guests, a note to yourself. */
export const JUST_YOU = "just-you";
/** A file shared with anyone who has the link. */
export const ANYONE = "anyone";

/** Calendar actions that, without guests, stay on your own calendar. */
const OWN_CALENDAR = /^GOOGLECALENDAR_(CREATE_EVENT|QUICK_ADD|UPDATE_EVENT|PATCH_EVENT)$/;

/** Email addresses anywhere in a value: "a@x.com, b@y.com", ["a@x.com"], [{email}], Outlook's {emailAddress: {address}}. */
function emails(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return value.split(/[,;\s]+/).map((s) => s.replace(/^.*<|>$/g, "").trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+$/.test(s));
  if (depth > 3 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => emails(v, depth + 1));
  const o = value as Record<string, unknown>;
  return ["email", "address", "emailAddress", "email_address"].flatMap((k) => emails(o[k], depth + 1));
}

/** Drive's "anyone with the link" and "everyone at acme.com", which name no one. */
function audiences(args: Record<string, unknown>): string[] {
  const grants = Array.isArray(args.permissions) ? (args.permissions as Record<string, unknown>[]) : [args];
  return grants.flatMap((g) => (g?.type === "anyone" ? [ANYONE] : g?.type === "domain" && typeof g.domain === "string" ? [`*@${g.domain.toLowerCase()}`] : []));
}

function ids(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return Array.isArray(value) ? value.flatMap(ids) : [];
}

export function targetsOf(slug: string, args: Record<string, unknown>): string[] {
  const people = [...new Set([...PEOPLE.flatMap((k) => emails(args[k])), ...(slug.startsWith("GOOGLEDRIVE_") ? audiences(args) : [])])];
  if (people.length) return people;
  const places = [...new Set(PLACES.flatMap((k) => ids(args[k])))];
  if (places.length) return places;
  if (typeof args.owner === "string" && typeof args.repo === "string") return [`${args.owner}/${args.repo}`.toLowerCase()];
  if (typeof args.org === "string") return [args.org.toLowerCase()];
  if (OWN_CALENDAR.test(slug)) return [JUST_YOU];
  return ["*"];
}

/** A few words of what's being done, for the approval card: the subject, the title, the first lines. */
export function previewOf(args: Record<string, unknown>): string | undefined {
  for (const k of ["subject", "summary", "title", "name", "text", "markdown_text", "body", "message", "description", "query", "content"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 140);
  }
}
