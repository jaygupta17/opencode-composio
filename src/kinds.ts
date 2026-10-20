/**
 * What an action does to your stuff, the axis people choose permissions on:
 * reading it, changing it (sending counts), or deleting it.
 *
 * Composio's schemas don't say, so we read the verbs in the slug. Anything we
 * can't place counts as a change, so an unknown action asks rather than acts.
 */
export type Kind = "read" | "write" | "delete";

/** Gone for good: the email, the file, the cells' contents. */
const DELETE = new Set(["DELETE", "DELETES", "TRASH", "CLEAR", "PURGE", "DESTROY", "EMPTY"]);
const WRITE = new Set([
  "SEND", "CREATE", "INSERT", "UPDATE", "PATCH", "MOVE", "ADD", "IMPORT", "DUPLICATE", "QUICK", "WATCH", "STOP", "SET", "POST", "REPLY", "FORWARD",
  "MODIFY", "UPLOAD", "COPY", "RENAME", "SHARE", "INVITE", "MARK", "APPLY", "STAR", "UNSTAR", "ARCHIVE", "UNARCHIVE", "CHANGE", "EDIT",
  "REPLACE", "APPEND", "WRITE", "MERGE", "CLOSE", "REOPEN", "ASSIGN", "UNASSIGN", "START", "RUN", "EXECUTE", "TRIGGER", "ACCEPT", "DECLINE",
  "RESPOND", "SUBMIT", "UNDO", "CANCEL", "COMMENT", "REACT", "PIN", "UNPIN", "JOIN", "LEAVE", "KICK", "PUBLISH", "APPROVE", "DISMISS", "LOCK",
  "UNLOCK", "RESTORE", "SCHEDULE", "UNTRASH", "FOLLOW", "UNFOLLOW", "TRANSFER", "ENABLE", "DISABLE", "RERUN", "DISPATCH", "FORK",
  "INVITE", "OPEN", "SNOOZE", "REMOVE", "REMOVES", "UNSUBSCRIBE", "REVOKE", "REREQUEST", "MUTE", "UNMUTE", "SUBSCRIBE", "CONVERT", "LINK", "UNLINK", "EMPTY", "RESIZE", "SORT", "FORMAT", "HIDE", "UNHIDE",
]);
const READ = new Set([
  "GET", "LIST", "FETCH", "SEARCH", "FIND", "QUERY", "READ", "RETRIEVE", "LOOKUP", "CHECK", "COUNT", "DOWNLOAD", "EXPORT", "DESCRIBE", "VIEW",
  "INSTANCES", "FREE", "BUSY", "SUMMARIZE", "COMPARE", "INFO", "STATUS", "DIFF", "PREVIEW", "VALIDATE", "WHOAMI", "WHO",
  "PARSE", "AGGREGATE", "IS", "RENDER", "TRANSLATE", "VERIFY", "GENERATE",
]);

/** Verbs that make a change right after a reading word, as in "find and replace". Later on they're nouns: "get project update". */
const STRONG = new Set(["CREATE", "UPDATE", "REPLACE", "SEND", "INSERT", "PATCH", "MOVE", "POST", "UPLOAD", "SET"]);

/** Hand calls where the verbs mislead. */
const OVERRIDES: Record<string, Kind> = {
  GOOGLECALENDAR_SYNC_EVENTS: "read",
  GOOGLECALENDAR_GET_CURRENT_DATE_TIME: "read",
  GOOGLECALENDAR_REMOVE_ATTENDEE: "write",
  GOOGLECALENDAR_CALENDAR_LIST_DELETE: "write", // hides a calendar from your list; the calendar stays
  GMAIL_MOVE_TO_TRASH: "delete",
  GMAIL_SEND_DRAFT: "write",
  GMAIL_REMOVE_LABEL: "write",
  GMAIL_ADD_LABEL_TO_EMAIL: "write",
  SLACK_API_TEST: "read",
  SLACK_TEST_AUTH: "read",
  GITHUB_API_ROOT: "read",
  // Taking a label, a star, a person off something undoes a link; it isn't lost. These few are lost.
  SLACK_REMOVE_REMOTE_FILE: "delete",
  // Formatting and settings, not your data.
  GOOGLEDOCS_DELETE_PARAGRAPH_BULLETS: "write",
  GOOGLESHEETS_CLEAR_BASIC_FILTER: "write",
  GITHUB_CLEAR_SELF_HOSTED_RUNNER_ORG_LABELS: "write",
  GITHUB_CLEAR_PROJECT_V2_ITEM_FIELD_VALUE: "write",
  // Stops notifications.
  GITHUB_DELETE_A_THREAD_SUBSCRIPTION: "write",
  GITHUB_DELETE_A_REPOSITORY_SUBSCRIPTION: "write",
  // Makes a token for removing a runner; removes nothing.
  GITHUB_CREATE_A_REMOVE_TOKEN_FOR_A_REPOSITORY: "write",
  GITHUB_CREATE_A_REMOVE_TOKEN_FOR_AN_ORGANIZATION: "write",
  GITHUB_EXPORT_A_CODESPACE_FOR_THE_AUTHENTICATED_USER: "write",
  // A model answering; nothing of yours changes.
  GITHUB_CREATE_INFERENCE_CHAT_COMPLETIONS: "read",
  GITHUB_CREATE_INFERENCE_EMBEDDINGS: "read",
};

export function kindOf(slug: string, app: string): Kind {
  if (OVERRIDES[slug]) return OVERRIDES[slug];
  // Nouns that look like verbs: Gmail's "send as" addresses.
  const words = (slug.startsWith(`${app.toUpperCase()}_`) ? slug.slice(app.length + 1) : slug).replace(/SEND_AS/g, "ALIAS").replace(/^BATCH_/, "").split("_");
  if (words.some((w) => DELETE.has(w))) return "delete";
  // "List pending invite requests" reads: the verb comes first.
  const then = words[1] === "AND" ? words[2] : words[1];
  if (READ.has(words[0]) && !STRONG.has(then)) return "read";
  if (words.some((w) => WRITE.has(w))) return "write";
  if (words.some((w) => READ.has(w))) return "read";
  return "write";
}
