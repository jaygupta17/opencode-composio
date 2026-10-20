/**
 * Composio Connect, spoken to directly with a consumer key (`ck_…`): the same
 * endpoint the MCP server uses, but we call its tools ourselves so each app
 * action can become its own OpenCode tool.
 */
import { gunzipSync } from "node:zlib";

const URL = "https://connect.composio.dev/mcp";
/** Composio's sandbox cuts a command's output at about 40k characters; read saved results in pieces under that. */
const CHUNK = 36_000;
/** Pieces to read before giving up on a result: about 1.4 MB compressed, many MB of JSON. */
const MAX_CHUNKS = 40;

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
type Result = { response?: { successful?: boolean; data?: unknown; data_preview?: unknown; error?: string }; error?: string; index?: number };

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

  /** A command in Composio's sandbox, where it keeps big results. */
  async function bash(command: string, signal?: AbortSignal) {
    const out = await call<{ stdout?: string; stderr?: string }>("COMPOSIO_REMOTE_BASH_TOOL", { command }, signal);
    const stdout = out?.stdout ?? "";
    if (!stdout || stdout.includes("(output truncated")) throw new ComposioError(out?.stderr?.trim() || "Composio's sandbox didn't answer.");
    return stdout;
  }

  /** The whole of a big result, gzipped and read back in pieces small enough for the sandbox's output. */
  async function saved(file: string, index: number, about: string | undefined, signal?: AbortSignal): Promise<unknown> {
    const tokens = Number(/\((\d+) tokens\)/.exec(about ?? "")?.[1]);
    const tooBig = () => new ComposioError(`That result is too big to bring back${tokens ? ` (${tokens.toLocaleString("en")} tokens)` : ""}. Ask for less: fewer results, a narrower time range, a search query, or only the fields you need.`);
    if (!/^\/mnt\/files\/[\w./-]+\.json$/.test(file) || !Number.isInteger(index)) throw tooBig();
    const packed = `${file}.${index}.gz64`;
    const head = await bash(
      `python3 -c "import json,gzip,base64;d=json.load(open('${file}'))['results'][${index}]['response'].get('data');b=base64.b64encode(gzip.compress(json.dumps(d,separators=(',',':')).encode(),9)).decode();open('${packed}','w').write(b);print(len(b));print(b[:${CHUNK}],end='')"`,
      signal,
    ).catch((e) => {
      throw signal?.aborted ? e : tooBig();
    });
    const nl = head.indexOf("\n");
    const total = Number(head.slice(0, nl));
    if (!Number.isFinite(total) || total > CHUNK * MAX_CHUNKS) throw tooBig();
    const offsets: number[] = [];
    for (let o = CHUNK; o < total; o += CHUNK) offsets.push(o);
    const rest = await Promise.all(offsets.map((o) => bash(`python3 -c "print(open('${packed}').read()[${o}:${o + CHUNK}],end='')"`, signal)));
    void bash(`rm -f '${packed}'; echo ok`).catch(() => {});
    const b64 = head.slice(nl + 1) + rest.join("");
    if (b64.length !== total) throw tooBig();
    return JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf8"));
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
      const data = await call<{ results?: Result[]; remote_file_info?: { file_path?: string; message?: string } }>(
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        { tools: [{ tool_slug: slug, arguments: args ?? {} }], sync_response_to_workbench: false },
        signal,
      );
      const r = data?.results?.[0];
      if (!r) throw new ComposioError("Composio didn't run the action.");
      const error = r.response?.successful === false ? (r.response.error ?? r.error) : r.error;
      if (error) throw new ComposioError(error);
      if (r.response && "data" in r.response) return r.response.data;
      // A big result: Composio keeps it in its sandbox and sends only a preview, which would read as the whole thing.
      if (r.response?.data_preview === undefined) return undefined;
      return saved(data.remote_file_info?.file_path ?? "", r.index ?? 0, data.remote_file_info?.message, signal);
    },
  };
}

export type Client = ReturnType<typeof client>;
