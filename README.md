# opencode-composio

Your apps (Gmail, Google Calendar, Slack, GitHub, Notion, Linear…) as [OpenCode](https://opencode.ai) tools, one per action, each with its own permission. It talks to [Composio Connect](https://composio.dev) with your consumer key, so there's nothing to host.

- **One tool per action.** Every connected app becomes a namespace (`gmail.send_email`, `googlecalendar.create_event`), so agents see real inputs instead of a generic "call any tool" bridge.
- **One permission per action.** Each action is named `composio.<app>.<read|write|delete>.<action>`, and its resource is who or what it reaches. Allow mail to `*@acme.com`, ask before anything else is sent, and block deletes everywhere.
- **Approvals that say what will happen.** Requests carry the app, the action, who it reaches and a one-line preview, so a client can show "Send email to Ana: Friday's plan" rather than a raw tool name.
- **The rest of Composio's 500+ apps.** `apps.search` finds actions in apps you haven't featured, and `apps.run` runs them, under the same permission names.

Requires OpenCode 2.1 or later.

## Install

Get a consumer key (`ck_…`) from the [Composio dashboard](https://dashboard.composio.dev) under **For You → Sessions & API Key**, save it to a file, and add the plugin to your OpenCode config:

```json
{
  "plugins": [
    {
      "package": "github:jaygupta17/opencode-composio#<commit>",
      "options": { "keyFile": "~/.config/opencode/composio.key" }
    }
  ]
}
```

Pin a full commit hash. OpenCode keeps pinned plugins as they are, and checks unpinned ones (`#main`, or no ref) for updates. OpenCode installs the plugin when the server starts.

Then connect apps, either in the Composio dashboard or by asking an agent ("connect my Gmail"). It calls `apps.connect` and gives you a sign-in link. Apps you connect elsewhere show up within a few minutes.

### Options

| Option     | What it does                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `keyFile`  | Path to a file holding the consumer key.                                                                  |
| `key`      | The key itself, if a file isn't handy. Prefer `keyFile`, which keeps the key out of your config.          |
| `defaults` | `{ read, write, delete }`: what agents may do with no rule of yours. Default `{ read: "allow", write: "ask", delete: "ask" }`. |

## Permissions

Rules are ordinary OpenCode permission rules, so they go wherever your other rules do: globally, or on one agent. The last matching rule wins.

| Action                              | Covers                           |
| ----------------------------------- | -------------------------------- |
| `composio.*`                        | every app                        |
| `composio.gmail.*`                  | just Gmail                       |
| `composio.*.write.*`                | anything that sends or changes   |
| `composio.*.delete.*`               | anything that deletes            |
| `composio.gmail.write.send_email`   | one action                       |
| `composio.connect`                  | connecting an app (resource: the app) |

The resource is what the action reaches:

| Resource          | Means                                         |
| ----------------- | --------------------------------------------- |
| `just-you`        | nobody else: a private event, a draft         |
| `anyone`          | anyone with the link                          |
| `*@acme.com`      | everyone at a domain                          |
| `ana@acme.com`    | one person                                    |
| `#launch`, `acme/web` | a channel, a repo, a page…                |

For example, to let one agent send mail inside your company without asking, and never delete anything:

```json
{
  "permissions": [
    { "action": "composio.gmail.write.send_email", "resource": "*@acme.com", "effect": "allow" },
    { "action": "composio.*.delete.*", "resource": "*", "effect": "deny" }
  ]
}
```

A denied action disappears from the agent's tools entirely. When you choose "Always" on an approval, OpenCode remembers that action for those people or places, not the whole action.

The defaults sit right after an agent's last catch-all `allow`. Any rule of yours about apps still wins, and an agent that's stricter than "allow everything" stays that way.

### `permissions.json`

Every featured app's actions with their permission names and titles, for clients that let people set permissions per action:

```json
{ "version": "0.1.0", "apps": { "gmail": { "name": "Gmail", "actions": [["composio.gmail.write.send_email", "Send email"], …] } } }
```

It's exported as `opencode-composio/permissions.json`, or fetch it from the commit you pin:

```
https://raw.githubusercontent.com/jaygupta17/opencode-composio/<commit>/permissions.json
```

## Development

```bash
bun run catalog       # refresh src/catalog.json from Composio's docs, then permissions.json
bun run permissions   # rebuild permissions.json from the catalog
```

Commit `permissions.json` with any change to the catalog or to how actions are sorted into read, write and delete. Git installs don't run build scripts.

To try a local checkout, point the plugin's `package` at its folder.

## License

MIT
