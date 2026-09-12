# StackBridge API Reference

Protocol version **1**. This document is for extension developers calling StackBridge from a Chrome extension (MV3).

## 1. Setup

### 1.1 Manifest

```json
{
  "manifest_version": 3,
  "name": "Your Extension",
  "version": "0.1.0",
  "permissions": ["tabs"],
  "background": { "service_worker": "background.js" },
  "externally_connectable": { "ids": ["<VIVALDI_UI_ID>"] }
}
```

`<VIVALDI_UI_ID>` — the extension ID of Vivaldi's UI context. Get it once from the window.html DevTools console (`vivaldi:inspect` → inspect `window.html`): `chrome.runtime.id`. It is derived from a build-baked manifest key and should be stable across Vivaldi updates; still, treat it as configuration.

**Verified value**: Vivaldi **8.2.4133.52** reports `chrome.runtime.id` = `mpognobbkildjkofajifpdfhcoklimli`.

### 1.2 Pairing (not required in the current dev build)

**The current StackBridge build performs no authentication — any external extension can call all actions.** Pairing is planned for a future release (see the README TODO); the error flow below describes the target behavior so client code can be written against it now.

Planned behavior: the first request from an unpaired extension returns:

```json
{ "ok": false, "error": { "code": "NOT_PAIRED", "message": "Extension not paired. Run StackBridge.pair(id) in window.html console." } }
```

To pair, the user opens the window.html DevTools console (`vivaldi:inspect` → inspect `window.html`) and runs:

```js
StackBridge.pair("<your-extension-id>")  // 32 chars, alphabet a–p
StackBridge.list()                       // show paired ids
StackBridge.unpair("<id>")               // revoke (omit arg = revoke all)
StackBridge.capabilities()               // inspect from the console side
```

In the current build these commands exist but are **no-ops** (they log a DEBUG notice and change nothing) — client code that handles `NOT_PAIRED` will simply never see it yet.

### 1.3 Capability discovery

`bridge.capabilities` returns what this Vivaldi build supports. **Check it before using write actions** — private APIs are undocumented and may be absent or changed:

```json
{
  "protocol": 1,
  "nativeStacking": true,
  "groupTitle": true,
  "groupColor": true,
  "unstack": true,
  "events": true,
  "actions": ["bridge.ping", "bridge.capabilities", "tabs.list", "stacks.list",
              "stacks.create", "stacks.addTabs", "stacks.removeTabs",
              "stacks.rename", "stacks.setColor", "stacks.unstack", "stacks.pin",
              "events.subscribe", "events.unsubscribe"]
}
```

## 2. Transport

### 2.1 Envelope

Every message carries `v` (protocol version), `type`, and — for requests/responses — a correlation `id` you generate:

```
Request:  { "v": 1, "id": "<uuid>", "type": "request", "action": "<name>", "params": { ... } }
Response: { "v": 1, "id": "<same uuid>", "type": "response", "ok": true,  "result": { ... } }
          { "v": 1, "id": "<same uuid>", "type": "response", "ok": false, "error": { "code": "...", "message": "..." } }
Event:    { "v": 1, "type": "event", "event": "stacks.changed", "data": { "stacks": [ ... ] } }
```

### 2.2 Request helper

```js
const UI_ID = "<VIVALDI_UI_ID>";
const TIMEOUT = 8000;

function callBridge(action, params = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("BRIDGE_TIMEOUT")), TIMEOUT);
    chrome.runtime.sendMessage(UI_ID, { v: 1, id, type: "request", action, params }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || resp.v !== 1 || resp.id !== id) return reject(new Error("BAD_RESPONSE"));
      resp.ok ? resolve(resp.result)
              : reject(Object.assign(new Error(resp.error.message || resp.error.code), { code: resp.error.code }));
    });
  });
}
```

> MV3 note: `sendMessage` with a callback wakes the service worker; no persistent connection is needed.

### 2.3 Events

```js
// subscribe (returns capabilities in the result)
await callBridge("events.subscribe");

// receive pushed snapshots
chrome.runtime.onMessageExternal.addListener((msg, sender) => {
  if (sender.id !== UI_ID || msg?.v !== 1 || msg.type !== "event") return;
  if (msg.event === "stacks.changed") renderStacks(msg.data.stacks);
});
```

Events are **debounced full snapshots** (150 ms after the last tab change), not deltas. Native `chrome.tabs.onMoved/onUpdated/...` events also reach your extension independently; use the snapshot for resolved stack names and membership.

## 3. Data shapes

### 3.1 Stack

```json
{
  "id": "f81d4fae-...",          // native groupExtId (string)
  "name": "研究Kimi K3模型",       // native title, "" when unnamed
  "named": true,                  // name !== ""
  "tabIds": [12, 15, 18],
  "tabCount": 3,
  "pinnedCount": 0,
  "tabs": [
    { "id": 12, "index": 3, "title": "...", "url": "https://...", "pinned": false }
  ]
}
```

A stack exists when ≥ 2 tabs share a `group` value in their `vivExtData`. Unnamed stacks are included with `name: ""`.

### 3.2 Tab

```json
{ "id": 12, "index": 3, "title": "...", "url": "https://...", "pinned": false, "active": true, "groupId": "f81d4fae-...", "windowId": 1 }
```

`groupId` is `null` for unstacked tabs.

## 4. Actions

### Read actions (all stack/tab reading goes through the bridge)

> **Do not parse `vivExtData` in your extension.** Stack state is reconstructed from Vivaldi's undocumented `vivExtData` metadata — a private format with no stability guarantee, and its visibility in the extension context is unverified. The bridge is the single source of truth for stack semantics: `stacks.list` output is byte-identical to the `stacks.changed` event snapshot, and a parser change only ever lands in the bridge, not in your code. If you need raw tab data for other purposes, standard `chrome.tabs.query` still works — just never derive stack state from it.

#### `bridge.ping`

Health check. Returns `{ "pong": true, "protocol": 1 }`.

#### `bridge.capabilities`

See §1.3.

#### `tabs.list` → `Tab[]`

Params: `{ windowId?: number }` (omit = current window).

#### `stacks.list` → `Stack[]`

Params: `{ windowId?: number }` (omit = current window).

### Write actions (require native stacking; serialized by a mutex)

#### `stacks.create`

Create a native stack from 2+ tabs.

| Param | Type | Required | Notes |
|---|---|---|---|
| `tabIds` | `number[]` | yes | 2–200 unique non-negative integers; pinned tabs rejected |
| `name` | `string` | no | ≤ 50 chars (truncated); omitted = unnamed stack |
| `color` | `string` | no | Native stack color, requires `groupColor` capability |

Returns `{ "groupExtId": "..." }`. Errors: `TOO_FEW_TABS`, `PINNED_TABS`, `GROUPED_TABS`, `UNSUPPORTED_API`. Member order follows the tab strip; if every member already belongs to one stack, that stack is dissolved first (clean slate), and members spanning multiple stacks are rejected with `GROUPED_TABS`.

#### `stacks.addTabs`

Move tabs into an existing stack. Implementation rebuilds the native group with all members (existing + new), preserving the name.

| Param | Type | Required | Notes |
|---|---|---|---|
| `tabIds` | `number[]` | yes | Tabs to move in |
| `stackId` | `string` | yes | Target stack id |
| `name` | `string` | no | Explicit name wins; otherwise inherited from any named member |

Returns `{ "groupExtId": "..." }`. Errors: `NO_SUCH_STACK`, `TOO_FEW_TABS`, `PINNED_TABS` (adding pinned tabs to an unpinned stack).

#### `stacks.removeTabs`

Remove tabs from a stack. If fewer than 2 tabs remain, the stack is dissolved (`tabsPrivate.unstack`) and group metadata is cleared.

| Param | Type | Required | Notes |
|---|---|---|---|
| `tabIds` | `number[]` | yes | Tabs to remove |
| `stackId` | `string` | yes | Source stack id |

Returns `{ "unstacked": true }` when the stack dissolved, otherwise the rebuilt group result.

#### `stacks.rename`

Rename a stack (native title + `vivExtData` bookkeeping). Param: `{ stackId: string, name: string }` (≤ 50 chars). Returns `{ "ok": true }`.

#### `stacks.setColor`

Set the native stack color. Param: `{ stackId: string, color: string }`. Requires `groupColor` capability. Returns `{ "ok": true }`.

#### `stacks.unstack`

Dissolve an entire stack; all former members lose group metadata. Param: `{ stackId: string }`. Returns `{ "unstacked": true }`.

#### `stacks.pin`

Pin or unpin every member of a stack. Param: `{ stackId: string, pinned?: boolean }` (default `true`). Returns `{ "pinnedCount": n }`.

### Event actions

#### `events.subscribe` → `{ "subscribed": true, "capabilities": {...} }`

#### `events.unsubscribe` → `{ "subscribed": false }`

## 4b. Protocol v2 — declarative layout (`v: 2` envelopes)

Protocol 2 is additive: every v1 action remains fully served on v1 envelopes, `bridge.capabilities` reports `"protocol": 2, "versions": [1, 2]`, and responses echo the request's `v`.

### `layout.apply` → `{ rev, applied: [{ name, groupExtId, tabIds, unchanged? }], dissolved: [groupId], skipped: [{ tabId? | group?, reason }] }`

The external extension declares the **entire desired end-state**; the bridge computes the diff against one snapshot and orchestrates everything in a single locked pass — the shape of TidyTabs' one-shot Tidy flow.

```jsonc
// request params
{
  "groups": [
    { "name": "V2EX", "color": "color1", "tabIds": [101, 102] },
    { "tabIds": [103, 104] }            // name/color optional
  ],
  "ungrouped": [105]                     // optional: tabs that must end up unstacked
}
```

Orchestration (all under one mutation lock and watchdog):

1. **Plan** — one snapshot; unresolvable/pinned/duplicate/over-claimed tabs are reported in `skipped` (reasons: `NOT_IN_WINDOW`, `PINNED`, `ALREADY_CLAIMED`, `GROUP_TOO_SMALL`) instead of failing the call.
2. **Reconcile existing stacks** (TidyTabs' dismantle step) — stacks losing members to a target or to `ungrouped` are rebuilt with the remainder (full pipeline, title preserved) or dissolved when they drop below two members.
3. **Realize targets left-to-right** by anchor position — strip-order adjacency pre-pass → native move with contiguous strip-ordered ids → settle → `setGroupProperties` → per-member tree metadata. Members already in one stack get a fresh group ext id (TidyTabs' addTabs behavior) with the clean-slate audit dissolving the old group.
4. **Idempotency** — a target whose members already sit together in one stack under the requested title/color is reported with `"unchanged": true` and left untouched. Re-sending the same layout is a no-op; after any partial failure, re-sending it converges (self-healing).

`rev` increments per successful apply (per mod session). Errors: `BAD_PARAMS`, `GROUPED_TABS` (unreachable in practice — phase 1 dissolves conflicts first), `UNSUPPORTED_API`, watchdog errors.

v1 clients are unaffected; `layout.apply` on a `v: 1` envelope returns `WRONG_VERSION`.

## 5. Error codes

| Code | Meaning | Typical recovery |
|---|---|---|
| `NOT_PAIRED` | Sender id not in the allowlist (**planned** — not returned by the current dev build) | User pairs via console (§1.2) |
| `UNSUPPORTED_API` | Required private API missing in this Vivaldi build | Check `bridge.capabilities`, degrade |
| `BAD_PARAMS` | Parameter validation failed | Fix the request |
| `TOO_FEW_TABS` | < 2 valid tabs for a stack operation | Ensure tabs exist and are valid |
| `PINNED_TABS` | Operation would mix pinned/unpinned members | Unpin or split the operation |
| `NO_SUCH_STACK` | `stackId` matches no tabs | Refresh state, re-query `stacks.list` |
| `GROUPED_TABS` | `stacks.create` members span more than one existing stack | Unstack the stacks or move members via `stacks.removeTabs` first, then create |
| `WRONG_VERSION` | v2-only action called on a v1 envelope | Send the request with `"v": 2` |
| `BUSY` | Another mutation in flight | Retry after a short delay |
| `STACKING_FAILED` | `tabsPrivate.move` returned no group id | Check capabilities; report upstream |
| `NATIVE_TIMEOUT` | A private Vivaldi API call never responded (10 s watchdog) | Retry once; if it repeats, report the Vivaldi version |
| `MUTATION_TIMEOUT` | A stack mutation exceeded the 30 s overall bound (watchdog) | Retry once; if it repeats, report the Vivaldi version and the console log |
| `INTERNAL` | Unexpected error | See `message`; window.html console has details |

Note: `BRIDGE_TIMEOUT` and `BAD_RESPONSE` come from the client helper (§2.2), not the bridge.

## 6. Behavioral notes & caveats

- **UI updates are automatic.** Writes go through Vivaldi's native write path; the tab bar re-renders on its own. Never try to notify the UI yourself.
- **Mutations are serialized.** Concurrent write requests get `BUSY`. Read actions are never blocked.
- **Member order follows the tab strip, not `tabIds` order.** `tabIds` selects WHICH tabs are grouped; the resulting group order is their current strip order (TidyTabs/Vivaldi-UI-aligned). Tabs are pre-placed contiguously in strip order before the native group move, so the move never reorders inside the contiguous run — the native flow the Vivaldi UI itself exercises. Sort `tabIds` before sending if the caller needs to know the resulting order.
- **Names are capped at 50 characters** (Vivaldi's own limit for fixed titles); longer names are silently truncated.
- **Stack state is window-scoped in v1.** Omitting `windowId` operates on the current window.
- **Uninstall safety.** `bridge.sh uninstall` removes only the bridge mod. Stack state (`vivExtData`) is part of tab metadata and survives; the native stacks remain fully functional without the mod.
- **Pairing state survives mod updates** (planned: stored in window.html's origin localStorage, not in mod files).
- **No authentication in the current dev build.** Any extension can call all actions, including mutations. Do not run this build with untrusted extensions installed.
