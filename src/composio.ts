/**
 * Composio Connect, spoken to directly with a consumer key (`ck_…`): the same
 * endpoint the MCP server uses, but we call its tools ourselves so each app
 * action can become its own OpenCode tool.
 */
const URL = "https://connect.composio.dev/mcp";

export class ComposioError extends Error {}

export type Account = { id: string; status: string; alias?: string };
export type Schema = { slug: string; app: string; description: string; input: Record<string, unknown> };
type RawSchema = { toolkit?: string; tool_slug: string; description?: string; input_schema?: Record<string, unknown> };
export type Found = {
  results: { use_case: string; recommended_plan_steps?: string[]; known_pitfalls?: string[]; primary_tool_slugs?: string[]; related_tool_slugs?: string[]; toolkits?: string[] }[];
  toolkit_connection_statuses?: { toolkit: string; description?: string; has_active_connection: boolean }[];
  tool_schemas?: Record<string, RawSchema>;
};

const schemaOf = (s: RawSchema): Schema => ({ slug: s.tool_slug, app: (s.toolkit ?? s.tool_slug.split("_")[0]).toLowerCase(), description: s.description ?? "", input: s.input_schema ?? { type: "object", properties: {} } });
export type Link = { url: string; accountId?: string };

export function client(key: string) {
  let id = 0;

  async function rpc<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "x-consumer-api-key": key, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal,
    });
    if (res.status === 401 || res.status === 403) throw new ComposioError("Composio didn't accept the key. Copy it again from the Composio dashboard.");
    if (!res.ok) throw new ComposioError(`Composio answered ${res.status}.`);
    const text = await res.text();
    // A short event stream or plain JSON, depending on Composio's mood.
    const body = text.trimStart().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
    if (!body) throw new ComposioError("Composio sent an empty answer.");
    const msg = JSON.parse(body) as { result?: T; error?: { message?: string } };
    if (msg.error) throw new ComposioError(msg.error.message ?? "Composio returned an error.");
    return msg.result as T;
  }

  /** One of Composio's own tools, unwrapped from `{successful, data, error}`. */
  async function call<T>(name: string, args: unknown, signal?: AbortSignal): Promise<T> {
    const r = await rpc<{ content?: { type: string; text?: string }[] }>("tools/call", { name, arguments: args }, signal);
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    let out: { successful?: boolean; data?: T; error?: string | null };
    try {
      out = JSON.parse(text);
    } catch {
      throw new ComposioError(text || "Composio returned something unexpected.");
    }
    if (out.successful === false && out.data === undefined) throw new ComposioError(out.error || "Composio couldn't do that.");
    return out.data as T;
  }

  return {
    /** Accounts per app, for the apps asked about. */
    async accounts(apps: string[]): Promise<Record<string, Account[]>> {
      const data = await call<{ results: Record<string, { accounts?: Account[] }> }>("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: apps.map((name) => ({ name, action: "list" })) });
      return Object.fromEntries(apps.map((a) => [a, (data.results?.[a]?.accounts ?? []).map((x) => ({ ...x, status: x.status.toLowerCase() }))]));
    },

    /** A sign-in link for an app, good for about ten minutes. */
    async link(app: string): Promise<Link> {
      const data = await call<{ results: Record<string, { redirect_url?: string; accounts?: Account[] }> }>("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: app, action: "add" }] });
      const r = data.results?.[app];
      if (!r?.redirect_url) throw new ComposioError(`Composio didn't return a sign-in link for ${app}.`);
      return { url: r.redirect_url, accountId: r.accounts?.find((a) => a.status.toLowerCase() === "initiated")?.id };
    },

    /** Input schemas for these actions, fetched in batches. */
    async schemas(slugs: string[]): Promise<Schema[]> {
      const out: Schema[] = [];
      for (let i = 0; i < slugs.length; i += 50) {
        const data = await call<{ tool_schemas: Record<string, RawSchema> }>("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: slugs.slice(i, i + 50) });
        for (const s of Object.values(data.tool_schemas ?? {})) out.push(schemaOf(s));
      }
      return out;
    },

    /** Search Composio's whole catalog for actions that fit a use case: a plan, the actions and their schemas, whether their apps are connected. */
    async search(useCase: string, signal?: AbortSignal): Promise<Found & { schemas: Schema[] }> {
      const found = await call<Found>("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: useCase }], session: { generate_id: true } }, signal);
      return { ...found, schemas: Object.values(found.tool_schemas ?? {}).map(schemaOf) };
    },

    /** Run one action. Resolves with its data, or throws its error in plain words. */
    async run(slug: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
      const data = await call<{ results?: { response?: { successful?: boolean; data?: unknown; error?: string }; error?: string }[] }>(
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        { tools: [{ tool_slug: slug, arguments: args ?? {} }], sync_response_to_workbench: false },
        signal,
      );
      const r = data?.results?.[0];
      if (!r) throw new ComposioError("Composio didn't run the action.");
      const error = r.response?.successful === false ? (r.response.error ?? r.error) : r.error;
      if (error) throw new ComposioError(error);
      return r.response?.data;
    },
  };
}

export type Client = ReturnType<typeof client>;
