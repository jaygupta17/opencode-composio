/**
 * opencode-composio: your apps (Gmail, Calendar, Slack, GitHub…) as OpenCode
 * tools, one per action, each with its own permission.
 *
 * Every action is named `composio.<app>.<read|write|delete>.<action>` for
 * permissions, so rules can be as broad or as fine as you like:
 *
 *   composio.*                          every app
 *   composio.gmail.*                    just Gmail
 *   composio.*.write.*                  anything that sends or changes
 *   composio.*.delete.*                 anything that deletes
 *   composio.gmail.write.send_email     one action
 *
 * and the resource is who or what it reaches (recipients, guests, channel,
 * repo), so "allow mail to *@acme.com" works, and "Always allow" remembers
 * that person rather than the whole action. Blocked actions vanish from the
 * agent's tools entirely.
 *
 * Only apps you've connected get tools. `apps.search` and `apps.run` reach
 * the rest of Composio's 500+ apps, under the same permission names. Talks to
 * Composio Connect with your consumer key; nothing to host.
 *
 * Options:
 *   keyFile   path to a file holding the consumer key (ck_…)
 *   key       the key itself, if a file isn't handy
 *   defaults  { read, write, delete }: what agents may do without a rule of
 *             yours; default { read: "allow", write: "ask", delete: "ask" }
 */
import { Plugin } from "@opencode/plugin";
import { readFile } from "node:fs/promises";
import catalog from "./catalog.json" with { type: "json" };
import { client, ComposioError, type Schema } from "./composio";
import { labeler } from "./labels";
import { kindOf, type Kind } from "./kinds";
import { previewOf, targetsOf } from "./targets";

type Effect = "allow" | "ask" | "deny";
type Catalog = Record<string, { name: string; actions: { slug: string; title: string }[] }>;
type Action = { app: string; slug: string; name: string; title: string; kind: Kind; schema: Schema };
type Call = { sessionID: string; agent?: string; messageID: string; id: string; signal: AbortSignal };

const APPS = catalog as Catalog;
/** Schemas change rarely; a day keeps startup quick and the tools current. Bump the version in the key when their shape changes. */
const SCHEMA_TTL = 24 * 60 * 60_000;
/** How often to notice apps connected elsewhere (the dashboard, another device). */
const RECHECK = 5 * 60_000;

/** How long a new session waits on a recheck that just ran. */
const FRESH = 30_000;
/** Said wherever the agent meets app actions: a "no" is an answer, not an obstacle. */
const DECLINED = "If the user declines an action, the error carries their reply: take it as their answer, don't retry or work around it, and ask them if it's unclear.";

const appName = (app: string) => APPS[app]?.name ?? app.charAt(0).toUpperCase() + app.slice(1);
/** TRELLO_ADD_CARDS → "Add cards", for actions outside the catalog. */
const titleOf = (app: string, slug: string) => shortName(app, slug).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** GOOGLECALENDAR_CREATE_EVENT → create_event */
const shortName = (app: string, slug: string) => (slug.startsWith(`${app.toUpperCase()}_`) ? slug.slice(app.length + 1) : slug).toLowerCase();
const permissionOf = (a: { app: string; kind: Kind; name: string }) => `composio.${a.app}.${a.kind}.${a.name}`;

export default Plugin.define({
  id: "opencode-composio",
  async setup(ctx) {
    const options = ctx.options as { keyFile?: string; key?: string; defaults?: Partial<Record<Kind, Effect>> };
    const defaults: Record<Kind, Effect> = { read: "allow", write: "ask", delete: "ask", ...options.defaults };
    const key = options.key?.trim() || (options.keyFile ? (await readFile(options.keyFile, "utf8").catch(() => "")).trim() : "");
    if (!key) {
      console.warn("[opencode-composio] No Composio key: set the keyFile or key option. Apps are off.");
      return;
    }
    const composio = client(key);
    const names = labeler(composio);

    /** Connected apps and their actions, as registered right now. */
    let connected: string[] = [];
    let actions: Action[] = [];
    let loaded = false;
    /** Schemas of actions found with apps.search, for apps.run. */
    const known = new Map<string, Schema>();

    await ctx.tool.transform((editor) => {
      for (const app of connected) editor.namespace({ name: app, description: `${appName(app)}, through your Composio account. ${DECLINED}` });
      for (const a of actions) {
        editor.add({
          name: a.name,
          description: a.schema.description || a.title,
          input: a.schema.input,
          options: { namespace: a.app, permission: permissionOf(a) },
          execute: (input, tc) => act(a, (input ?? {}) as Record<string, unknown>, tc),
        });
      }

      // Ours, always there: find and connect apps.
      editor.namespace({ name: "apps", description: `Find, connect and use apps (Gmail, Calendar, Slack, GitHub and 500+ more) through Composio. ${DECLINED}` });
      editor.add({
        name: "connect",
        description:
          "Get a sign-in link to connect an app, for when a task needs one that isn't connected. Give the link to the user as a Markdown link titled `Connect <App>`; their app tools appear once they've signed in.",
        input: { type: "object", properties: { app: { type: "string", description: "The app's Composio slug, such as gmail, googlecalendar, slack, github, notion." } }, required: ["app"] },
        options: { namespace: "apps", permission: "composio.connect" },
        execute: async (input, tc) => {
          const app = String((input as { app: string }).app).toLowerCase().replace(/[^a-z0-9_]/g, "");
          await asking(tc, { action: "composio.connect", resources: [app], save: [app], metadata: { app, appName: appName(app) } });
          const link = await composio.link(app);
          void watch(app);
          return { content: `Give the user this link as is: [Connect ${appName(app)}](${link.url})\nIt works for about ten minutes. Once they've signed in, their ${appName(app)} tools appear.` };
        },
      });
      editor.add({
        name: "status",
        description: "Which apps are connected, and which actions each has.",
        input: { type: "object", properties: {} },
        options: { namespace: "apps", permission: "composio.status" },
        execute: async () => ({
          content: connected.length
            ? connected.map((app) => `${appName(app)} (${app}): ${actions.filter((a) => a.app === app).length} actions`).join("\n")
            : "No apps connected yet. Use apps.connect to connect one.",
        }),
      });
      editor.add({
        name: "search",
        description:
          "Find actions for a task across 500+ apps (Trello, Jira, HubSpot, Airtable…), for when no tool you have does it. Returns the actions with their inputs, a suggested plan and known pitfalls; run one with apps.run.",
        input: { type: "object", properties: { task: { type: "string", description: "What you want to do, in plain words, such as \"create a Trello card\" or \"find HubSpot deals closing this month\"." } }, required: ["task"] },
        options: { namespace: "apps", permission: "composio.search" },
        execute: async (input, tc) => {
          const found = await composio.search(String((input as { task: string }).task), tc.signal);
          for (const schema of found.schemas) known.set(schema.slug, schema);
          return { content: describe(found) };
        },
      });
      editor.add({
        name: "run",
        description: `Run an app action found with apps.search, by its slug (such as TRELLO_ADD_CARDS). Its app has to be connected. ${DECLINED}`,
        input: {
          type: "object",
          properties: { action: { type: "string", description: "The action's slug, as apps.search gave it." }, arguments: { type: "object", description: "The action's input, matching its schema from apps.search.", additionalProperties: true } },
          required: ["action"],
        },
        options: { namespace: "apps", permission: "composio.run" },
        execute: async (input, tc) => {
          const { action, arguments: args } = input as { action: string; arguments?: Record<string, unknown> };
          const slug = String(action).trim().toUpperCase();
          const ours = actions.find((a) => a.slug === slug);
          const schema = ours?.schema ?? known.get(slug) ?? (await composio.schemas([slug]))[0];
          if (!schema) throw new ComposioError(`There's no action called ${slug}. Use apps.search to find one.`);
          const app = ours?.app ?? schema.app;
          return act({ app, slug, name: shortName(app, slug), title: ours?.title ?? titleOf(app, slug), kind: kindOf(slug, app) }, args ?? {}, tc);
        },
      });
    });

    /** Ask, if the rules say to, with everything the approval card needs; then do it. */
    async function act(a: Omit<Action, "schema">, args: Record<string, unknown>, tc: Call) {
      const targets = targetsOf(a.slug, args);
      // Ids mean nothing to a person: name them, for actions that might ask.
      const named = a.kind === "read" ? {} : await names(a.app, a.slug, args, tc.signal);
      await asking(tc, {
        action: permissionOf(a),
        resources: targets,
        save: targets,
        metadata: { app: a.app, appName: appName(a.app), action: a.title, kind: a.kind, targets, names: named, about: Object.values(named)[0], preview: previewOf(args) },
      });
      const data = await composio.run(a.slug, args, tc.signal);
      return { content: JSON.stringify(data ?? null), metadata: { app: a.app, action: a.title, kind: a.kind, targets } };
    }

    /**
     * `permission.assert` for this tool call. Stopping the session takes back
     * the question too, so an approval can't outlive the work it was for.
     */
    async function asking(tc: Call, request: { action: string; resources: string[]; save: string[]; metadata: Record<string, unknown> }) {
      tc.signal.throwIfAborted();
      const withdraw = () =>
        void (async () => {
          const pending = await ctx.permission.list({ sessionID: tc.sessionID });
          const list = (Array.isArray(pending) ? pending : ((pending as { data?: unknown[] }).data ?? [])) as { id: string; source?: { id?: string } }[];
          for (const r of list.filter((r) => r.source?.id === tc.id)) await ctx.permission.reply({ sessionID: tc.sessionID, requestID: r.id, decision: "reject" } as never);
        })().catch(report);
      tc.signal.addEventListener("abort", withdraw, { once: true });
      try {
        await ctx.permission.assert({ sessionID: tc.sessionID, agent: tc.agent, source: { type: "tool", messageID: tc.messageID, id: tc.id }, ...request } as never);
      } finally {
        tc.signal.removeEventListener("abort", withdraw);
      }
    }

    /** Search results, short enough for the model: each action's inputs, the plan, the pitfalls, what to connect. */
    function describe(found: Awaited<ReturnType<typeof composio.search>>) {
      const out: string[] = [];
      const offline = (found.toolkit_connection_statuses ?? []).filter((t) => !t.has_active_connection).map((t) => t.toolkit.toLowerCase());
      for (const r of found.results) {
        const slugs = r.primary_tool_slugs ?? [];
        if (!slugs.length) continue;
        out.push(`## ${r.use_case}`);
        for (const app of r.toolkits ?? []) if (offline.includes(app.toLowerCase())) out.push(`${appName(app)} isn't connected: connect it with apps.connect({ app: "${app.toLowerCase()}" }) first.`);
        for (const slug of slugs) {
          const schema = found.schemas.find((s) => s.slug === slug);
          out.push(`\n### ${slug}\n${schema?.description ?? ""}`);
          if (schema) out.push(inputsOf(schema.input));
        }
        if (r.related_tool_slugs?.length) out.push(`\nAlso useful: ${r.related_tool_slugs.join(", ")} (their inputs come with another apps.search)`);
        // The plan names Composio's own helpers; ours are apps.connect and apps.run.
        const plain = (lines?: string[]) => (lines ?? []).filter((l) => !/COMPOSIO_|workbench|run_composio_tool/i.test(l));
        if (plain(r.recommended_plan_steps).length) out.push(`\nPlan:\n${plain(r.recommended_plan_steps).map((l) => `- ${l}`).join("\n")}`);
        if (plain(r.known_pitfalls).length) out.push(`\nPitfalls:\n${plain(r.known_pitfalls).map((l) => `- ${l}`).join("\n")}`);
      }
      return out.length ? `${out.join("\n")}\n\nRun an action with apps.run({ action: "<SLUG>", arguments: {...} }).` : "No actions found for that. Try describing the task differently.";
    }

    /** "- idList (string, required): ID of the list…" for each input. */
    function inputsOf(input: Record<string, unknown>) {
      const props = (input.properties ?? {}) as Record<string, { type?: string; description?: string; enum?: unknown[] }>;
      const required = new Set((input.required as string[] | undefined) ?? []);
      const lines = Object.entries(props).map(([k, p]) => `- ${k} (${p.type ?? (p.enum ? "enum" : "any")}${required.has(k) ? ", required" : ""})${p.enum ? ` one of ${p.enum.join(", ")}` : ""}: ${(p.description ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
      return lines.length ? `Inputs:\n${lines.join("\n")}` : "No inputs.";
    }

    // Safe defaults: reading is fine, sending and deleting ask, unless the
    // agent's own rules say otherwise. They sit right after the agent's last
    // catch-all, so any rule of yours about apps still wins, and an agent
    // that's stricter than "allow everything" stays that way.
    let seen = new Set<string>();
    const placeDefaults = (editor: Parameters<Parameters<typeof ctx.agent.transform>[0]>[0]) => {
      const ours = (["read", "write", "delete"] as const).filter((k) => defaults[k] !== "allow").map((k) => ({ action: `composio.*.${k}.*`, resource: "*", effect: defaults[k] }));
      seen = new Set(editor.list().map((a) => String(a.id)));
      for (const agent of editor.list()) {
        editor.update(agent.id, (ag) => {
          const rules = ag.permissions as { action: string; resource: string; effect: Effect }[];
          const at = rules.findLastIndex((r) => r.action === "*" && r.resource === "*");
          if (at < 0 || rules[at].effect !== "allow") return;
          rules.splice(at + 1, 0, ...ours);
        });
      }
    };
    let defaultsReg = await ctx.agent.transform(placeDefaults);
    /** Agents from your config come from a transform that registers late. If ours ran before it, go again, after it. */
    async function placeDefaultsLast() {
      const agents = await ctx.agent.list();
      const list = (Array.isArray(agents) ? agents : ((agents as { data?: unknown[] }).data ?? [])) as { id: string }[];
      if (list.every((a) => seen.has(String(a.id)))) return;
      const next = await ctx.agent.transform(placeDefaults);
      await defaultsReg.dispose();
      defaultsReg = next;
      await ctx.agent.reload();
    }

    /** Read the cached schemas for an app, or fetch and cache them. */
    async function schemasFor(app: string): Promise<Schema[]> {
      const cached = (await ctx.storage.get(`schemas/2/${app}`)) as { at: number; schemas: Schema[] } | undefined;
      if (cached && Date.now() - cached.at < SCHEMA_TTL) return cached.schemas;
      const schemas = await composio.schemas(APPS[app].actions.map((a) => a.slug));
      await ctx.storage.set(`schemas/2/${app}`, { at: Date.now(), schemas } as never);
      return schemas;
    }

    let checked = 0;
    let checking: Promise<void> | undefined;
    /** One check at a time: the timer, a sign-in and a new session can all ask at once. */
    function refresh() {
      checking ??= check().finally(() => (checking = undefined));
      return checking;
    }

    async function check() {
      checked = Date.now();
      const accounts = await composio.accounts(Object.keys(APPS));
      const now = Object.keys(accounts).filter((app) => accounts[app].some((a) => a.status === "active"));
      if (loaded && now.join() === connected.join()) return;
      const next: Action[] = [];
      // All at once: GitHub alone takes ~20s cold, the rest a few seconds each.
      const fetched = await Promise.all(now.map(schemasFor));
      for (const [i, app] of now.entries()) {
        const titles = new Map(APPS[app].actions.map((a) => [a.slug, a.title]));
        for (const schema of fetched[i]) {
          const name = shortName(app, schema.slug);
          if (!/^[a-z0-9_]+$/.test(name)) continue;
          next.push({ app, slug: schema.slug, name, title: titles.get(schema.slug) ?? name, kind: kindOf(schema.slug, app), schema });
        }
      }
      connected = now;
      actions = next;
      loaded = true;
      await ctx.tool.reload();
      console.info(`[opencode-composio] ${now.length ? now.map((a) => `${appName(a)} (${next.filter((x) => x.app === a).length})`).join(", ") : "no apps connected"}`);
    }

    /** After handing out a sign-in link, notice the moment it's used. */
    async function watch(app: string) {
      const until = Date.now() + 10 * 60_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 3000));
        const accounts = await composio.accounts([app]).catch(() => null);
        if (accounts?.[app]?.some((a) => a.status === "active") && !connected.includes(app)) return refresh().catch(report);
      }
    }

    const report = (e: unknown) => console.warn(`[opencode-composio] ${e instanceof ComposioError ? e.message : String(e)}`);
    // Don't hold up startup on the network: register what we find when we find it.
    void refresh().catch(report);
    const early = setTimeout(() => void placeDefaultsLast().catch(report), 2000);
    // A new session is when apps connected elsewhere (the dashboard, another device) should already be there.
    const events = ctx.event.subscribe()[Symbol.asyncIterator]();
    void (async () => {
      for (let e = await events.next(); !e.done; e = await events.next()) {
        if ((e.value as { type?: string }).type === "session.created" && Date.now() - checked > FRESH) void refresh().catch(report);
      }
    })().catch(report);
    const timer = setInterval(() => {
      void refresh().catch(report);
      void placeDefaultsLast().catch(report);
    }, RECHECK);
    return async () => {
      clearInterval(timer);
      clearTimeout(early);
      await events.return?.();
      await defaultsReg.dispose();
    };
  },
});
