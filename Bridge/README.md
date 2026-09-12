# StackBridge

A standalone Vivaldi mod that wraps Vivaldi's private tab-stack APIs behind a versioned JSON-RPC surface callable by **any external Chrome extension**.

> This directory is an independent project that uses the [Awesome-Vivaldi](https://github.com/angryLid/Awesome-Vivaldi) repository as its **reference documentation only**. It does not share the modpack's development, installation, or maintenance system. Do not run the Awesome-Vivaldi installer or `dev-install.sh` for this mod; use `bridge.sh` in this directory.

## What problem does it solve?

Vivaldi's browser UI (tab bar, stacks, workspaces) is itself a privileged web context — `window.html` — with access to private APIs like `vivaldi.tabsPrivate.*` that ordinary extensions can never call. Conversely, a Chrome extension is a sandboxed context that can only manipulate tabs through the standard `chrome.tabs` API and cannot create, name, color, or dissolve native tab stacks.

StackBridge closes this gap with a single-purpose mod:

```
┌─ Chrome extension (MV3, sandboxed) ─┐          ┌─ Vivaldi window.html (privileged) ─┐
│  background.js                      │          │  StackBridge.js                    │
│                                     │          │                                    │
│  stacks.list()          ──request──►│          │  ┌─ validation ─┐ ┌─ allowlist ─┐  │
│  stacks.create(...)     ──request──►┼─────────►│  │ envelope v1  │ │ sender.id   │  │
│                                     │          │  └──────────────┘ └─────────────┘  │
│  ◄───── response / error ───────────┼──────────┤  vivaldi.tabsPrivate.move          │
│  ◄───── event stacks.changed ───────┼──────────┤  vivaldi.tabsPrivate.              │
│                                     │  push    │    setGroupProperties / unstack    │
└─────────────────────────────────────┘          └────────────────────────────────────┘
                                                            │
                                                            ▼
                                            Vivaldi UI re-renders natively
                                            (no manual UI notification needed)
```

Key architectural facts:

- **Writes go through Vivaldi's own write path.** `tabsPrivate.move` with tweaks `["do-not-reparent", "create-new-group", "target-is-tab"]` is the exact recipe Vivaldi's own `PageActions` uses (see `Awesome-Vivaldi/Others/Reverse/bundle/modules/59322.js`). Because it is the native write path, all resulting events flow into Vivaldi's React store and **the tab bar updates itself** — the bridge never needs to notify the UI.
- **Never await `chrome.tabs.move`.** Its reorder DOES execute in the window.html context, but callback delivery is unreliable: observed on a real 8.x install, tabs moved while the awaited callback never fired, wedging the mutation until the watchdog caught it. TidyTabs' callback-style usage works but has the same latent race (a dropped callback just costs it a log line, since `tabsPrivate.move` finishes the job). Vivaldi's own UI never awaits it for reordering — every reorder in the bundle goes through `tabsPrivate.move`. The native group move also pulls scattered tabs into a contiguous run in the order given (the UI stacks multi-selections), so no adjacency pre-pass exists.
- **Metadata writes are serial and awaited, and skipped when native data is already current.** Unlike `move`, `chrome.tabs.get`/`update` callbacks ARE reliable in this context (TidyTabs awaits them in production), so all vivExtData writes go through one awaited `updateTabMeta` helper with a 100 ms settle after structural moves. Earlier builds fired these concurrently and fire-and-forget; that raced Vivaldi's own post-move vivExtData commit — stale snapshots were written back over fresh native data, and in-stack activation desynced (first click jumped and reverted, a tab could escape its group).
- **Reads are bridge-owned too.** Tab objects carry `vivExtData` (a JSON blob with `group`, `fixedGroupTitle`, …), but extensions should not parse it themselves: the field is undocumented, has no stability guarantee, and its visibility in the extension context is unverified. All stack semantics ("what is a stack") live in the bridge — `stacks.list` returns exactly the same shape as the `stacks.changed` event snapshot, one parser, one source of truth. Extensions that need raw tabs still have standard `chrome.tabs.query`.
- **Private API calling convention: promise-style, never a trailing callback.** Vivaldi 8 exposes `tabsPrivate.*` as promise-based functions — its own UI bundle only ever `await`s them (see `Others/Reverse/bundle/modules/59322.js`). A callback-style call wedged silently on a real 8.x install (no response, no exception, mutation lock leaked). `callPrivate` therefore calls promise-style first, falls back to the callback form only when that throws or returns nothing, and races every native call against a 10 s `NATIVE_TIMEOUT` watchdog; mutations are additionally bounded by a 30 s `MUTATION_TIMEOUT` so the lock always releases even if a wedge happens elsewhere in the chain.
- **Events are pushed, not polled.** The mod debounces native tab churn (150 ms) and pushes a full `stacks.changed` snapshot to subscribed extensions over `chrome.runtime.sendMessage`.

## Security model

> **Dev build status: authentication is disabled.** The current build accepts every external extension unconditionally — no pairing, no allowlist. This is intentional for development; a full authentication mechanism is planned (see [TODO](#todo)). The enforcement point is marked `AUTH-CHECK` in `mod/StackBridge.js` so it can be re-inserted surgically.

The window.html context is *more* privileged than any extension, so the bridge must never become a raw API re-export. The design (to be re-enabled with authentication) is capability-scoped:

| Layer | Mechanism | Status |
|---|---|---|
| Transport | `chrome.runtime.onMessageExternal` / `sendMessage` (versioned envelope, `v: 1`) | active |
| Authentication | `sender.id` pairing — browser-endorsed, cannot be forged | **planned (TODO)** |
| Capability scoping | Only semantic *intents* (`stacks.create`) are exposed. `tabsPrivate`, `chrome.scripting`, prefs, and history are never reachable through the protocol | active |
| Validation | Every handler validates parameter types and ranges (tab-id integers, max 200 per call, name ≤ 50 chars — Vivaldi's own fixed-title cap) | active |
| Re-entrancy | All mutations serialize through a mutex; concurrent mutations get `BUSY` | active |
| Degradation | Every private call is feature-detected; missing APIs produce typed errors (`UNSUPPORTED_API`) and `bridge.capabilities()` reports what works | active |

Why extension IDs instead of shared tokens (the planned design): `sender.id` is filled in by the browser and cannot be spoofed, while tokens are knowledge-based credentials that leak (readable extension sources, console logs, copy-paste). Pairing by ID gives "I trust exactly this extension installed in this browser" semantics with zero key management.

## Logging

All logging goes to the window.html console (`vivaldi:inspect/#apps` → inspect window.html) behind a `[StackBridge]` prefix, with two levels:

| Level | Covers | Printed when |
|---|---|---|
| `DEBUG` | Request/response traces (action, sender, params/result preview, latency), native `tabsPrivate` write calls, event fan-out, startup state | `LOG_LEVEL = LEVELS.DEBUG` |
| `ERROR` | Any request answered with an error response, unknown actions, or a condition that disabled the bridge | always |

`LOG_LEVEL` is a single constant near the top of `mod/StackBridge.js`. The dev build ships with `LEVELS.DEBUG` enabled; raise it to `LEVELS.ERROR` for a quiet production build.

## TODO

- [ ] **Authentication mechanism** (planned — removed from the dev build)
  - Re-insert sender enforcement at the `AUTH-CHECK` mark in `mod/StackBridge.js` (the removed code rejected unauthenticated senders with `NOT_PAIRED` after checking a localStorage allowlist via `isPaired(sender.id)`).
  - Pairing UX: `window.StackBridge.pair/unpair/list` console commands still exist as documented no-ops; wire them back to the allowlist (localStorage key `stackbridge.config.v1` was the old store; consider ModConfig/OPFS instead for consistency with other mods).
  - Optional hardening once auth lands: split actions into read tier (open) / write tier (paired) instead of gating everything.
  - Design decision to preserve: identity = `sender.id` (browser-endorsed, unfakeable), never shared tokens.
- [x] ~~Probe `chrome.runtime.onMessageExternal` availability in window.html on a real install~~ **verified**: the bridge registers and receives external traffic on Vivaldi 8.2.4133.52 (fail-fast guard remains in place as a safety net).
- [x] ~~Probe whether external extensions can deliver to the Vivaldi UI context~~ **verified**: `bridge.ping` / `bridge.capabilities` / `stacks.list` / `stacks.create` all round-tripped from a real external extension, and `stacks.create` produced a visible native group in the UI (23 ms end-to-end).
- [x] ~~Probe `vivExtData` visibility in the extension context~~ **obsolete**: all stack reading is bridge-owned (`stacks.list` / `stacks.changed`); extensions never parse `vivExtData` themselves, so extension-side visibility no longer matters.
- [ ] Consider exposing `vivExtData`-based client caching hooks only if profiling shows snapshot pushes are too chatty.
- [ ] Cross-window support: `windowId` params are accepted but v1 reads operate on the current window.
- [ ] Windows support in `bridge.sh` (currently macOS + Linux only).

## Status / verification gates

Two facts about the transport had to be probed on a real install before trusting it (they cannot be verified from source alone). Both are now verified on Vivaldi 8.2.4133.52:

1. ~~`typeof chrome.runtime.onMessageExternal` inside window.html~~ — present; the mod registers and serves external traffic (the fail-fast guard remains as a safety net for other Vivaldi versions).
2. ~~Whether an external extension can deliver to the Vivaldi UI context~~ — yes; `stacks.create` round-tripped from a real external extension and produced a visible native group in the UI (23 ms end-to-end).

A third fact only the real install could reveal — that `chrome.tabs.move` executes its reorder but does not reliably deliver its callback (so it must never be awaited), and `tabsPrivate.*` is promise-only — is now documented under the architecture notes above and encoded in `callPrivate` + the watchdogs.

The Vivaldi UI extension ID (address for outbound messages) derives from a baked-in manifest key via SHA-256, so it should be stable across Vivaldi updates — but treat it as configuration, not a constant.

**Verified on a real install** (Vivaldi 8.2.4133.52): `chrome.runtime.id` inside window.html = `mpognobbkildjkofajifpdfhcoklimli`; the external extension id observed in the logs (`miijjifoageohnhpichlnjcagebpmjhi`) round-tripped all actions.

## Layout

```
Bridge/
├── README.md            ← this file (design rationale)
├── API.md               ← protocol + action reference for extension developers
├── bridge.sh            ← install / uninstall / status (macOS + Linux; no Windows yet)
└── mod/
    └── StackBridge.js   ← the mod (self-contained, no shared-module dependencies)
```

## Quick start

```bash
# 1. Install the mod (discovers Vivaldi installs, injects the loader, deploys the mod)
./bridge.sh install

# 2. Deploy a client extension (manifest needs "externally_connectable")
#    See API.md for the full walkthrough.

# 3. Pair the extension: in vivaldi:inspect → window.html console
#    StackBridge.pair("<your-extension-id>")

# 4. From the extension
chrome.runtime.sendMessage(UI_ID, { v: 1, id: "1", type: "request", action: "bridge.ping" });
```

## Credits

- Private API surface and call recipes discovered from Vivaldi's own webpack bundles; analysis corpus in [Awesome-Vivaldi/Others/Reverse/](../Others/Reverse/README.md).
- Defensive patterns (promise/callback dual-mode calls, feature detection, `vivExtData` parsing) adapted from the TidyTabs mod in Awesome-Vivaldi.
