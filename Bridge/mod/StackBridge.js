// ==UserScript==
// @name         Stack Bridge
// @description  Wraps Vivaldi's private tab-stack APIs behind a versioned JSON-RPC surface callable by external Chrome extensions.
// @version      2026.9.12
// @author       angryLid
// ==/UserScript==

// StackBridge.js
// Single-purpose mod: a thin, validated, capability-scoped RPC bridge from the
// privileged window.html context down to ordinary Chrome extensions.
//
// Transport: chrome.runtime.sendMessage / onMessageExternal (envelope protocol).
// Write path: vivaldi.tabsPrivate.{move, setGroupProperties, unstack} — the same
// recipes Vivaldi's own PageActions uses, feature-detected before every call.
// Read path: chrome.tabs.query + vivExtData parsing (no private read API exists).
// Events: debounced stacks.changed snapshots pushed to subscribed extensions.
//
// Security model: NONE in the current dev build. Every external extension is
// accepted unconditionally. A pairing/authentication mechanism is planned —
// see README.md (TODO). The call site that will enforce it is marked with
// AUTH-CHECK below so it can be re-inserted without re-reading the design.

(() => {
  "use strict";

  const LOG = "[StackBridge]";
  const MOD_VERSION = "2026.9.12-r3"; // runtime build identity (date segment matches @version)
  const PROTOCOL_VERSION = 1;
  const EVENT_DEBOUNCE_MS = 150;
  const MAX_NAME_LEN = 50; // Vivaldi caps fixed titles at 50 chars (PageActions.setFixedTitle)
  const MAX_TABS_PER_CALL = 200;

  // Two-level logging: DEBUG traces requests/responses/event fan-out, ERROR reports failures and always prints; the dev build ships with DEBUG on.
  const LEVELS = { DEBUG: 10, ERROR: 20 };
  const LOG_LEVEL = LEVELS.DEBUG;
  const logDebug = (...args) => { if (LOG_LEVEL <= LEVELS.DEBUG) console.log(LOG, ...args); };
  const logError = (...args) => { console.error(LOG, ...args); };

  // ── feature detection ──────────────────────────────────────────────────

  const tp = () => window.vivaldi?.tabsPrivate || null;
  const hasPrivate = () => !!(tp() && typeof tp().move === "function");
  const hasExternal = !!(chrome.runtime?.onMessageExternal);
  const hasSetGroupProperties = () => !!(tp() && typeof tp().setGroupProperties === "function");
  const hasUnstack = () => !!(tp() && typeof tp().unstack === "function");

  if (!hasExternal) {
    logError("chrome.runtime.onMessageExternal unavailable — bridge disabled");
    return;
  }

  // ── pairing / config — REMOVED for the dev build (see README TODO: authentication).
  // Keep the console surface as a no-op so docs and muscle memory stay valid.
  window.StackBridge = {
    pair: (extId) => { logDebug("pair() is a no-op: authentication not implemented yet"); return [extId].filter(Boolean); },
    unpair: () => [],
    list: () => [],
    capabilities,
  };

  // ── helpers ────────────────────────────────────────────────────────────

  const queryTabs = (windowId) =>
    new Promise((resolve) => chrome.tabs.query(windowId ? { windowId } : { currentWindow: true }, resolve));

  const parseViv = (tab) => {
    try {
      return typeof tab.vivExtData === "string" ? JSON.parse(tab.vivExtData) : (tab.vivExtData || {});
    } catch { return {}; }
  };

  // Vivaldi 8 exposes tabsPrivate.* as promise-based functions — its own UI bundle only ever awaits them and never passes a callback (Others/Reverse/bundle/modules/59322.js). A callback-style call wedged silently on a real 8.x install: the browser never responds, the promise never settles and the mutation lock leaks. Call promise-style first; the callback form is only a fallback for old callback-era bindings.
  const NATIVE_CALL_TIMEOUT_MS = 10000; // a non-responding native call must not hold the mutation lock forever

  const err = (code, message) => Object.assign(new Error(message || code), { code });

  const raceTimeout = (promise, label, ms = NATIVE_CALL_TIMEOUT_MS, code = "NATIVE_TIMEOUT") =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(err(code, `${label} gave no response within ${ms}ms`)), ms)),
    ]);

  const callPrivate = (fn, params, label) => {
    const attempt = new Promise((resolve, reject) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      const withCallback = () => {
        try { fn(params, (res) => (chrome.runtime.lastError ? fail(new Error(chrome.runtime.lastError.message)) : done(res))); }
        catch (e) { fail(e); }
      };
      let ret;
      try { ret = fn(params); }
      catch { return withCallback(); }
      if (ret && typeof ret.then === "function") ret.then(done, fail);
      else withCallback();
    });
    return raceTimeout(attempt, label || "tabsPrivate call");
  };

  const clampName = (name) => String(name || "").trim().slice(0, MAX_NAME_LEN);

  // Compact one-line preview of a value for log lines (truncated, never throws).
  const short = (v) => { try { const s = JSON.stringify(v) ?? String(v); return s.length > 120 ? `${s.slice(0, 117)}…` : s; } catch { return "[unserializable]"; } };

  // ── stack state assembly (read path) ───────────────────────────────────

  const buildStacks = (tabs) => {
    const byGroup = new Map();
    for (const t of tabs) {
      const v = parseViv(t);
      if (!v.group) continue;
      if (!byGroup.has(v.group)) {
        byGroup.set(v.group, {
          id: String(v.group),
          name: v.fixedGroupTitle || "",
          tabIds: [],
          tabs: [],
          pinnedCount: 0,
        });
      }
      const s = byGroup.get(v.group);
      s.tabIds.push(t.id);
      s.tabs.push({ id: t.id, index: t.index, title: t.title, url: t.url, pinned: !!t.pinned });
      if (t.pinned) s.pinnedCount++;
    }
    return [...byGroup.values()].map((s) => ({
      ...s,
      named: !!s.name,
      tabCount: s.tabIds.length,
    }));
  };

  const listStacks = async ({ windowId } = {}) => buildStacks(await queryTabs(windowId));

  const listTabs = async ({ windowId } = {}) =>
    (await queryTabs(windowId)).map((t) => {
      const v = parseViv(t);
      return { id: t.id, index: t.index, title: t.title, url: t.url, pinned: !!t.pinned, active: !!t.active, groupId: v.group ? String(v.group) : null, windowId: t.windowId };
    });

  // ── stack mutations (write path — recipes lifted from Vivaldi PageActions) ──

  // The one and only write step: the native group move also pulls scattered members into a
  // contiguous run in the order given — exactly what PageActions.createTabStack relies on when
  // stacking a scattered multi-selection. There is NO chrome.tabs.move adjacency pre-pass:
  // its reorder DOES execute in the window.html context, but callback delivery is unreliable
  // (observed on a real 8.x install: tabs moved while the awaited callback never fired,
  // wedging the mutation), and Vivaldi's own UI never awaits it for reordering anyway.
  const rebuildGroup = async (tabIds, targetTabId) => {
    logDebug(`tabsPrivate.move: grouping ${tabIds.length} tabs onto target ${targetTabId}`);
    const res = await callPrivate(tp().move.bind(tp()), {
      tabIds,
      target: targetTabId,
      tweaks: ["do-not-reparent", "create-new-group", "target-is-tab"],
      debug: "StackBridge.rebuildGroup",
    }, "tabsPrivate.move");
    if (!res?.group) throw err("STACKING_FAILED", "tabsPrivate.move returned no group id");
    logDebug(`tabsPrivate.move ok → group ${String(res.group)}`);
    return String(res.group);
  };

  const setGroupTitle = async (groupId, name) => {
    if (!name) return;
    if (!hasSetGroupProperties()) throw err("UNSUPPORTED_API", "tabsPrivate.setGroupProperties unavailable");
    await callPrivate(tp().setGroupProperties.bind(tp()), { groupExtId: String(groupId), groupTitle: name }, "tabsPrivate.setGroupProperties");
  };

  const setGroupColor = async (groupId, color) => {
    if (!color) return;
    if (!hasSetGroupProperties()) throw err("UNSUPPORTED_API", "tabsPrivate.setGroupProperties unavailable");
    await callPrivate(tp().setGroupProperties.bind(tp()), { groupExtId: String(groupId), groupColor: color }, "tabsPrivate.setGroupProperties");
  };

  // Best-effort vivExtData refresh — fire-and-forget. Native stacking already writes `group` into
  // member tabs and setGroupProperties propagates the title, so this is redundant belt-and-suspenders;
  // chrome.tabs.* callbacks are not trusted to fire in the UI context, so never await them.
  const writeGroupMeta = (tabIds, groupId, name) => {
    for (const tabId of tabIds) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        const v = parseViv(tab);
        v.group = String(groupId);
        if (name) v.fixedGroupTitle = name;
        chrome.tabs.update(tabId, { vivExtData: JSON.stringify(v) }, () => void chrome.runtime.lastError);
      });
    }
  };

  // Shared mutation choreography: native group → title/color → fire-and-forget metadata refresh.
  const groupTabs = async (orderedTabs, { name, color }) => {
    const ids = orderedTabs.map((t) => t.id);
    const groupId = await rebuildGroup(ids, ids[0]);
    await setGroupTitle(groupId, name);
    await setGroupColor(groupId, color);
    writeGroupMeta(ids, groupId, name);
    return { groupExtId: groupId };
  };

  const validateTabIds = (tabIds) => {
    if (!Array.isArray(tabIds) || tabIds.length === 0) throw err("BAD_PARAMS", "tabIds must be a non-empty array");
    if (tabIds.length > MAX_TABS_PER_CALL) throw err("BAD_PARAMS", `tabIds exceeds ${MAX_TABS_PER_CALL}`);
    if (!tabIds.every((id) => Number.isInteger(id) && id >= 0)) throw err("BAD_PARAMS", "tabIds must be non-negative integers");
    return [...new Set(tabIds)];
  };

  // stacks.create
  const createStack = async ({ tabIds, name, color } = {}) => {
    if (!hasPrivate()) throw err("UNSUPPORTED_API", "tabsPrivate.move unavailable — native stacking not possible");
    const ids = validateTabIds(tabIds);
    const tabs = await queryTabs();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const moving = ids.map((id) => byId.get(id)).filter(Boolean);
    logDebug(`stacks.create: ${moving.length}/${ids.length} tabs resolved in current window`);
    if (moving.length < 2) throw err("TOO_FEW_TABS", "At least 2 valid tab ids are required");
    if (moving.some((t) => t.pinned)) throw err("PINNED_TABS", "Cannot group pinned tabs (Vivaldi restriction)");
    return groupTabs(moving, { name: clampName(name), color });
  };

  // stacks.addTabs — move tabs into an existing stack (rebuilds the group with all members)
  const addTabsToStack = async ({ tabIds, stackId, name } = {}) => {
    if (!hasPrivate()) throw err("UNSUPPORTED_API", "tabsPrivate.move unavailable");
    if (!stackId) throw err("BAD_PARAMS", "stackId is required");
    const ids = validateTabIds(tabIds);
    const tabs = await queryTabs();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const vivOf = (t) => parseViv(t);
    const existing = tabs.filter((t) => vivOf(t).group === String(stackId) && !ids.includes(t.id));
    const moving = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!existing.length && !moving.length) throw err("NO_SUCH_STACK", `No tabs found for stack ${stackId}`);
    if (moving.some((t) => t.pinned) && existing.some((t) => !t.pinned)) throw err("PINNED_TABS", "Cannot add pinned tabs to an unpinned stack");
    const members = [...existing, ...moving];
    if (members.length < 2) throw err("TOO_FEW_TABS", "Resulting stack would have fewer than 2 tabs");
    // effective name: explicit param wins, else inherit from any existing named member
    const effectiveName = name !== undefined
      ? clampName(name)
      : (existing.map((t) => vivOf(t).fixedGroupTitle).find(Boolean) || "");
    return groupTabs(members, { name: effectiveName });
  };

  // stacks.removeTabs — rebuild the source stack without the given tabs; unstack if it dissolves
  const removeTabsFromStack = async ({ tabIds, stackId } = {}) => {
    if (!stackId) throw err("BAD_PARAMS", "stackId is required");
    const ids = validateTabIds(tabIds);
    const tabs = await queryTabs();
    const remaining = tabs.filter((t) => parseViv(t).group === String(stackId) && !ids.includes(t.id));
    if (!remaining.length) return { unstacked: true };

    if (remaining.length < 2) {
      if (!hasUnstack()) throw err("UNSUPPORTED_API", "tabsPrivate.unstack unavailable");
      const lastId = remaining[0].id;
      await dissolveStack(stackId);
      // Best-effort metadata cleanup on the leftover tab — fire-and-forget (see writeGroupMeta).
      chrome.tabs.get(lastId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        const v = parseViv(tab);
        delete v.group;
        delete v.fixedGroupTitle;
        chrome.tabs.update(lastId, { vivExtData: JSON.stringify(v) }, () => void chrome.runtime.lastError);
      });
      return { unstacked: true };
    }
    return groupTabs(remaining, {});
  };

  // stacks.unstack — dissolve an entire stack
  const unstackStack = async ({ stackId } = {}) => {
    if (!stackId) throw err("BAD_PARAMS", "stackId is required");
    if (!hasUnstack()) throw err("UNSUPPORTED_API", "tabsPrivate.unstack unavailable");
    await dissolveStack(stackId);
    // Best-effort metadata cleanup for former members — fire-and-forget (see writeGroupMeta).
    const tabs = await queryTabs();
    for (const t of tabs) {
      const v = parseViv(t);
      if (v.group === String(stackId) || v.tidyStackId === String(stackId)) {
        delete v.group;
        delete v.fixedGroupTitle;
        chrome.tabs.update(t.id, { vivExtData: JSON.stringify(v) }, () => void chrome.runtime.lastError);
      }
    }
    return { unstacked: true };
  };

  // stacks.rename / stacks.setColor
  const renameStack = async ({ stackId, name } = {}) => {
    if (!stackId) throw err("BAD_PARAMS", "stackId is required");
    await setGroupTitle(stackId, clampName(name));
    const tabs = await queryTabs();
    for (const t of tabs) {
      const v = parseViv(t);
      if (v.group === String(stackId)) {
        v.fixedGroupTitle = clampName(name);
        chrome.tabs.update(t.id, { vivExtData: JSON.stringify(v) }, () => void chrome.runtime.lastError);
      }
    }
    return { ok: true };
  };

  const colorStack = async ({ stackId, color } = {}) => {
    if (!stackId) throw err("BAD_PARAMS", "stackId is required");
    await setGroupColor(stackId, color);
    return { ok: true };
  };

  // stacks.pin — pin every tab of a stack (Vivaldi's pinTabStack pins all members)
  const pinStack = async ({ stackId, pinned = true } = {}) => {
    if (!stackId) throw err("BAD_PARAMS", "stackId is required");
    const tabs = await queryTabs();
    const members = tabs.filter((t) => parseViv(t).group === String(stackId));
    for (const t of members) {
      if (t.pinned === !!pinned) continue;
      await new Promise((r) => chrome.tabs.update(t.id, { pinned: !!pinned }, () => r()));
    }
    return { pinnedCount: members.length };
  };

  // unstack may return a Promise or a plain value depending on Vivaldi version (TidyTabs pattern)
  const dissolveStack = async (groupId) => {
    const gid = String(groupId);
    logDebug(`tabsPrivate.unstack ${gid}`);
    const ret = tp().unstack(gid);
    if (ret && typeof ret.then === "function") await raceTimeout(ret, "tabsPrivate.unstack");
  };

  // ── capability report (drives extension-side graceful degradation) ─────

  function capabilities() {
    return {
      protocol: PROTOCOL_VERSION,
      nativeStacking: hasPrivate(),
      groupTitle: hasSetGroupProperties(),
      groupColor: hasSetGroupProperties(),
      unstack: hasUnstack(),
      events: true,
      actions: [
        "bridge.ping", "bridge.capabilities",
        "tabs.list", "stacks.list",
        "stacks.create", "stacks.addTabs", "stacks.removeTabs",
        "stacks.rename", "stacks.setColor", "stacks.unstack", "stacks.pin",
        "events.subscribe", "events.unsubscribe",
      ].filter((a) => {
        if (a.startsWith("stacks.") && a !== "stacks.list") return hasPrivate();
        return true;
      }),
    };
  }

  // ── mutation lock (tabsPrivate.move mutates shared UI state; no re-entrancy) ──

  let mutating = false;
  const MUTATION_TIMEOUT_MS = 30000; // bounds the whole mutation so a wedge anywhere still releases the lock
  const withLock = async (fn) => {
    if (mutating) throw err("BUSY", "Another stack mutation is in flight");
    mutating = true;
    try { return await raceTimeout(fn(), "mutation", MUTATION_TIMEOUT_MS, "MUTATION_TIMEOUT"); }
    finally { mutating = false; }
  };

  // ── request dispatch ───────────────────────────────────────────────────

  const HANDLERS = {
    "bridge.ping": async () => ({ pong: true, protocol: PROTOCOL_VERSION }),
    "bridge.capabilities": async () => capabilities(),
    "tabs.list": (p) => listTabs(p),
    "stacks.list": (p) => listStacks(p),
    "stacks.create": (p) => withLock(() => createStack(p)),
    "stacks.addTabs": (p) => withLock(() => addTabsToStack(p)),
    "stacks.removeTabs": (p) => withLock(() => removeTabsFromStack(p)),
    "stacks.rename": (p) => withLock(() => renameStack(p)),
    "stacks.setColor": (p) => withLock(() => colorStack(p)),
    "stacks.unstack": (p) => withLock(() => unstackStack(p)),
    "stacks.pin": (p) => withLock(() => pinStack(p)),
  };

  const subscribers = new Set(); // extIds that asked for events

  const reply = (sendResponse, id, ok, payload) => {
    try { sendResponse({ v: PROTOCOL_VERSION, id, type: "response", ok, ...payload }); }
    catch { /* port closed before response — nothing to do */ }
  };

  chrome.runtime.onMessageExternal.addListener((env, sender, sendResponse) => {
    if (!env || env.v !== PROTOCOL_VERSION) return; // not ours — stay silent for foreign traffic

    if (env.type !== "request") return;
    // AUTH-CHECK: pairing enforcement was removed for the dev build. When the
    // authentication mechanism lands, reject unauthenticated senders here (the
    // old code returned NOT_PAIRED after isPaired(sender.id)).
    const extId = sender.id;
    const startedAt = Date.now();

    if (env.action === "events.subscribe") {
      subscribers.add(extId);
      logDebug(`events.subscribe from ${extId} (${subscribers.size} subscribed)`);
      reply(sendResponse, env.id, true, { result: { subscribed: true, capabilities: capabilities() } });
      return;
    }
    if (env.action === "events.unsubscribe") {
      subscribers.delete(extId);
      logDebug(`events.unsubscribe from ${extId} (${subscribers.size} subscribed)`);
      reply(sendResponse, env.id, true, { result: { subscribed: false } });
      return;
    }

    const handler = HANDLERS[env.action];
    if (!handler) {
      logError(`UNKNOWN_ACTION "${env.action}" from ${extId}`);
      reply(sendResponse, env.id, false, { error: { code: "UNKNOWN_ACTION", message: `Unknown action: ${env.action}` } });
      return;
    }

    logDebug(`→ ${env.action} (id=${env.id}, from=${extId}) ${short(env.params)}`);
    Promise.resolve()
      .then(() => handler(env.params || {}))
      .then((result) => {
        logDebug(`← ok ${env.action} (${Date.now() - startedAt}ms) ${short(result)}`);
        reply(sendResponse, env.id, true, { result });
      })
      .catch((e) => {
        logError(`← ${env.action} failed (${e.code || "INTERNAL"}, ${Date.now() - startedAt}ms): ${e.message || e}`, e);
        reply(sendResponse, env.id, false, { error: { code: e.code || "INTERNAL", message: String(e.message || e) } });
      });
    return true; // keep sendResponse alive across the async work
  });

  // ── event push: debounced full snapshot after any tab churn ─────────────

  let eventTimer = null;
  const pushStacksChanged = () => {
    clearTimeout(eventTimer);
    eventTimer = setTimeout(async () => {
      if (!subscribers.size) return;
      const data = await listStacks();
      const event = { v: PROTOCOL_VERSION, type: "event", event: "stacks.changed", data };
      logDebug(`stacks.changed → ${subscribers.size} subscriber(s)`);
      for (const extId of subscribers) {
        chrome.runtime.sendMessage(extId, event, () => {
          // A stale subscriber (extension reloaded/removed) is routine churn, not a failure.
          if (chrome.runtime.lastError) logDebug(`push to ${extId} failed: ${chrome.runtime.lastError.message}`);
        });
      }
    }, EVENT_DEBOUNCE_MS);
  };

  ["onCreated", "onUpdated", "onMoved", "onRemoved", "onAttached", "onDetached"].forEach((ev) => {
    chrome.tabs[ev]?.addListener(pushStacksChanged);
  });

  logDebug(`Ready (v${MOD_VERSION}, protocol v${PROTOCOL_VERSION}, native stacking: ${hasPrivate()}, auth: disabled [dev build])`);
})();
