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
  const MOD_VERSION = "2026.9.12-r8"; // runtime build identity (date segment matches @version)
  const PROTOCOL_VERSION = 2;
  const PROTOCOL_VERSIONS = [1, 2]; // v1 actions stay fully served; v2 adds layout.apply
  const EVENT_DEBOUNCE_MS = 150;
  const MAX_NAME_LEN = 50; // Vivaldi caps fixed titles at 50 chars (PageActions.setFixedTitle)
  const MAX_TABS_PER_CALL = 200;
  const MOVE_SETTLE_MS = 100; // settle between structural moves and metadata reads (mirrors TidyTabs)
  const MUTATION_PACE_MS = 50; // pause between per-member metadata writes (mirrors TidyTabs)
  const MOVE_CB_RACE_MS = 500; // chrome.tabs.move callback is untrusted — race it with a timeout

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

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // The group move step. Since r6 the members are pre-placed in strip order, so
  // rebuildGroup always receives a contiguous run in the order the strip already has —
  // the exact input shape Vivaldi's own UI and TidyTabs produce, with no internal
  // reordering under do-not-reparent.
  // chrome.tabs.move still executes its reorder even when its callback is dropped
  // (observed on a real 8.x install), which is why the pre-pass races the callback instead
  // of awaiting it bare.
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

  // One adjacency move step. chrome.tabs.move executes its reorder even when its callback is
  // dropped, so the callback is raced against a timeout instead of being trusted — TidyTabs
  // awaits the callback bare and would hang forever on a dropped one (same latent race that
  // wedged our r1 mutation).
  const moveTabRace = (tabId, index) =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try { chrome.tabs.move(tabId, { index }, () => { void chrome.runtime.lastError; finish(); }); }
      catch { return finish(); }
      setTimeout(finish, MOVE_CB_RACE_MS);
    });

  // Adjacency pre-pass — TidyTabs-exact: members are placed at base+i in STRIP order (sorted
  // by current index), so every move is leftward and the single pass converges. Feeding the
  // native move a caller-scrambled order instead forces rightward moves that disrupt already
  // placed members (pass 1 never converged on a real install) and, worse, a contiguous but
  // non-strip-order input that makes tabsPrivate.move reorder INSIDE the run with
  // do-not-reparent suppressing tree updates — a native path Vivaldi's own UI never
  // exercises, and the latent tree corruption behind the delayed stack desync. Group member
  // order therefore follows the strip, matching what TidyTabs produces. Contiguity is
  // verified through the trusted read path (chrome.tabs.query) and retried once; correctness
  // never depends on move callbacks. Returns the members in strip order.
  const makeAdjacent = async (orderedTabs) => {
    const byStrip = [...orderedTabs].sort((a, b) => a.index - b.index);
    for (let pass = 1; pass <= 2; pass++) {
      const before = await queryTabs();
      const base = before.find((t) => t.id === byStrip[0].id)?.index ?? 0;
      for (let i = 0; i < byStrip.length; i++) await moveTabRace(byStrip[i].id, base + i);
      await wait(MOVE_SETTLE_MS);
      const after = await queryTabs();
      const idx = new Map(after.map((t) => [t.id, t.index]));
      if (byStrip.every((t, i) => idx.get(t.id) === base + i)) {
        logDebug(`adjacency pass ${pass}: members contiguous at indexes ${base}..${base + byStrip.length - 1} (strip order)`);
        return byStrip;
      }
      logDebug(`adjacency pass ${pass}: members not contiguous yet, retrying`);
    }
    logDebug("adjacency: verification inconclusive, proceeding with the native move anyway");
    return byStrip;
  };

  // Serial, awaited vivExtData touch-up for one tab: read fresh, apply mutate, write back only
  // when something actually differs. chrome.tabs.get/update callbacks ARE reliable in the
  // window.html context — only chrome.tabs.move's callback proved untrustworthy — and TidyTabs
  // runs this exact pattern awaited. When native already wrote the right data the update is
  // skipped entirely, so the common case costs zero writes and zero race surface.
  const updateTabMeta = (tabId, mutate) =>
    new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return resolve();
        const v = parseViv(tab);
        const before = JSON.stringify(v);
        mutate(v);
        if (JSON.stringify(v) === before) return resolve();
        logDebug(`vivExtData: writing tab ${tabId} → ${short(v)}`);
        chrome.tabs.update(tabId, { vivExtData: JSON.stringify(v) }, () => { void chrome.runtime.lastError; resolve(); });
      });
    });

  // TidyTabs-exact metadata write: unconditional update followed by a verification read.
  // Safe here because the choreography already settled after the structural moves and paces
  // one write at a time — the same conditions under which TidyTabs has run for years.
  const updateTabProps = (tabId, viv) =>
    new Promise((resolve) => {
      chrome.tabs.update(tabId, { vivExtData: JSON.stringify(viv) }, () => {
        void chrome.runtime.lastError;
        chrome.tabs.get(tabId, () => resolve());
      });
    });

  // Per-member metadata — aligned with TidyTabs' addTabToStack. Vivaldi's tab model is a
  // TREE keyed by vivExtData.ext_id / parent_ext_id: the first member is the root
  // (parent_ext_id null) and every other member points at the root's ext_id. Earlier
  // builds skipped the tree fields and relied on the native move having built the tree —
  // correct at first, but the scattered-input tree carried latent inconsistency that
  // Vivaldi normalized later (activation reordering, session sync), and the desync only
  // then surfaced: first click inside the stack jumped and reverted, and a tab could
  // escape its group. Rewriting the chain explicitly (plus 50 ms pacing between writes)
  // establishes the same self-consistent final state TidyTabs produces.
  const writeGroupMeta = async (tabIds, groupId, name, color) => {
    let rootExtId = null;
    for (let i = 0; i < tabIds.length; i++) {
      const tabId = tabIds[i];
      const v = await new Promise((resolve) => {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError || !tab) return resolve(null);
          try { resolve(typeof tab.vivExtData === "string" ? JSON.parse(tab.vivExtData) : (tab.vivExtData || {})); }
          catch { resolve({}); }
        });
      });
      if (!v) continue;
      const extId = v.ext_id || crypto.randomUUID(); // preserve native ext_id, generate only if missing
      v.ext_id = extId;
      v.group = String(groupId);
      v.tidyStackOwner = "StackBridge";
      v.tidyStackId = String(groupId);
      if (name) v.fixedGroupTitle = name;
      if (color) v.groupColor = color;
      v.parent_ext_id = i === 0 ? null : rootExtId;
      if (i === 0) rootExtId = extId;
      logDebug(`vivExtData: writing tab ${tabId} (parent_ext_id=${String(v.parent_ext_id)})`);
      await updateTabProps(tabId, v);
      if (i < tabIds.length - 1) await wait(MUTATION_PACE_MS);
    }
  };

  // Shared mutation choreography — fully aligned with TidyTabs.createTabStacks: strip-order
  // adjacency pre-pass (single converging pass) → native group move receives strip-ordered
  // contiguous ids (no internal reordering) → settle → title/color → per-member tree
  // metadata written sequentially with pacing.
  const groupTabs = async (orderedTabs, { name, color }) => {
    // Clean-slate invariant (TidyTabs-aligned): TidyTabs never runs create-new-group over
    // tabs still registered in another stack — it dismantles unnamed stacks first and
    // excludes named-stack members from its pool. Create-new-group over model-registered
    // members of another group is a native path nothing in Vivaldi exercises (tree updates
    // suppressed by do-not-reparent), and the resulting dual membership is what gets
    // normalized later — surfacing as delayed first-click desyncs and members escaping to
    // other groups. Dissolve a single shared old group automatically; refuse on mixed ones.
    const oldGroups = [...new Set(orderedTabs.map((t) => String(parseViv(t).group || "")).filter(Boolean))];
    if (oldGroups.length === 1) {
      logDebug(`stack mutation: members belong to stack ${oldGroups[0]} — dissolving it first (clean slate)`);
      await dissolveStack(oldGroups[0]);
    } else if (oldGroups.length > 1) {
      throw err("GROUPED_TABS", `Members span ${oldGroups.length} existing stacks — unstack or removeTabs them first`);
    }
    const strip = await makeAdjacent(orderedTabs);
    const ids = strip.map((t) => t.id);
    const groupId = await rebuildGroup(ids, ids[0]);
    // Let Vivaldi finish its own post-move vivExtData commit before we read anything back.
    await wait(MOVE_SETTLE_MS);
    await setGroupTitle(groupId, name);
    await setGroupColor(groupId, color);
    await writeGroupMeta(ids, groupId, name, color);
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
      // Metadata cleanup on the leftover tab — awaited, skipped when native already cleared it.
      await updateTabMeta(lastId, (v) => {
        delete v.group;
        delete v.fixedGroupTitle;
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
    // Settle, then serial awaited cleanup for former members — skipped when already cleared.
    await wait(MOVE_SETTLE_MS);
    const tabs = await queryTabs();
    for (const t of tabs) {
      const v = parseViv(t);
      if (v.group === String(stackId) || v.tidyStackId === String(stackId)) {
        await updateTabMeta(t.id, (x) => {
          delete x.group;
          delete x.fixedGroupTitle;
        });
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
      if (parseViv(t).group === String(stackId)) {
        await updateTabMeta(t.id, (x) => { x.fixedGroupTitle = clampName(name); });
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
      versions: PROTOCOL_VERSIONS,
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
        "layout.apply",
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

  // ── protocol v2: layout.apply — declarative end-state, TidyTabs-shaped orchestration ──

  // The external extension declares the WHOLE desired layout (groups with members and
  // optional title/color, plus tabs that must end up unstacked); the bridge computes the
  // diff against one snapshot and orchestrates everything in a single locked pass — the
  // same shape as TidyTabs' one-shot Tidy flow, which is where its stability comes from.
  // Idempotent: re-sending the same layout is a no-op. Self-healing: after any partial
  // failure, re-sending the same layout converges to it.
  let layoutRev = 0; // monotonic per mod session; lets callers detect divergent layouts
  const LAYOUT_MAX_GROUPS = 50;

  const applyLayout = async ({ groups, ungrouped } = {}) => {
    if (!hasPrivate()) throw err("UNSUPPORTED_API", "tabsPrivate.move unavailable — native stacking not possible");
    if (!Array.isArray(groups)) throw err("BAD_PARAMS", "groups must be an array");
    if (groups.length > LAYOUT_MAX_GROUPS) throw err("BAD_PARAMS", `groups exceeds ${LAYOUT_MAX_GROUPS}`);
    if (ungrouped !== undefined && !Array.isArray(ungrouped)) throw err("BAD_PARAMS", "ungrouped must be an array");

    // Phase 0 — one consistent snapshot; resolve and de-conflict the whole plan before
    // touching anything. Unresolvable/pinned/over-claimed tabs are reported, not fatal —
    // TidyTabs skips unsuitable tabs the same way.
    const tabs = await queryTabs();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const skipped = [];
    const claimed = new Map(); // tabId → target
    const resolveTab = (id) => {
      const t = byId.get(Number(id));
      if (!t) { skipped.push({ tabId: id, reason: "NOT_IN_WINDOW" }); return null; }
      if (t.pinned) { skipped.push({ tabId: id, reason: "PINNED" }); return null; }
      if (claimed.has(t.id)) { skipped.push({ tabId: t.id, reason: "ALREADY_CLAIMED" }); return null; }
      return t;
    };
    const targets = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.tabIds)) throw err("BAD_PARAMS", "each group needs a tabIds array");
      const name = clampName(g.name);
      const members = [];
      for (const id of g.tabIds) {
        const t = resolveTab(id);
        if (t) { members.push(t); claimed.set(t.id, null); }
      }
      if (members.length < 2) {
        for (const t of members) { claimed.delete(t.id); skipped.push({ tabId: t.id, reason: "GROUP_TOO_SMALL" }); }
        skipped.push({ group: name || null, reason: "GROUP_TOO_SMALL" });
        continue;
      }
      const target = { name, color: g.color, members };
      for (const t of members) claimed.set(t.id, target);
      targets.push(target);
    }
    const ungroupedSet = new Set();
    for (const id of Array.isArray(ungrouped) ? ungrouped : []) {
      const t = resolveTab(id);
      if (t) ungroupedSet.add(t.id);
    }

    const existing = buildStacks(tabs); // inventory from the same snapshot
    const dissolved = [];

    // Phase 1 — reconcile every existing stack touched by the plan (TidyTabs' dismantle
    // step). A stack CONTINUES when its members are claimed by one matching target — same
    // fixedGroupTitle, or a single target when the stack has no title (its identity is
    // memberhood). Members claimed by any other target or by `ungrouped` leave, and the
    // remainder keep the stack — rebuilt via the full pipeline if it still holds two or
    // more, dissolved otherwise. Getting this rule wrong dissolves stacks their own layout
    // asked to keep (caught by the idempotent re-apply harness scenario).
    for (const s of existing) {
      const claiming = new Set();
      let ungroupedLeaving = false;
      for (const id of s.tabIds) {
        if (ungroupedSet.has(id)) ungroupedLeaving = true;
        const t = claimed.get(id);
        if (t) claiming.add(t);
      }
      if (!claiming.size && !ungroupedLeaving) continue; // untouched by the plan
      const named = s.name ? targets.find((t) => t.name && t.name === s.name) : null;
      const continuation = named || (!ungroupedLeaving && claiming.size === 1 ? [...claiming][0] : null);
      const kept = s.tabIds.filter((id) => {
        if (ungroupedSet.has(id)) return false;
        const t = claimed.get(id);
        return !t || t === continuation;
      });
      if (kept.length === s.tabIds.length) continue; // nothing leaves after all
      if (kept.length >= 2) {
        logDebug(`layout.apply: rebuilding stack ${String(s.id).slice(0, 8)} with ${kept.length} remaining member(s)`);
        await groupTabs(kept.map((id) => byId.get(id)).filter(Boolean), { name: s.name || undefined });
      } else {
        logDebug(`layout.apply: dissolving stack ${String(s.id).slice(0, 8)} (drops below two members)`);
        await dissolveStack(s.id);
        dissolved.push(String(s.id));
      }
    }

    // Phase 2 — realize each target group, left-to-right by anchor position: the left group
    // is contiguous before the right one starts, so later pre-passes (whose moves are all
    // leftward within their own member set) cannot disturb it. groupTabs recreates the
    // group with a fresh ext id — TidyTabs' addTabs behavior — and its clean-slate audit
    // dissolves whatever single old group the members still share.
    targets.sort((a, b) => {
      const ia = Math.min(...a.members.map((m) => byId.get(m.id)?.index ?? Infinity));
      const ib = Math.min(...b.members.map((m) => byId.get(m.id)?.index ?? Infinity));
      return ia - ib;
    });
    const applied = [];
    for (const t of targets) {
      // Idempotency check against fresh state: a stack already holding exactly these
      // members under the requested title/color is left untouched.
      const fresh = await queryTabs();
      const freshById = new Map(fresh.map((x) => [x.id, x]));
      const memberTabs = t.members.map((m) => freshById.get(m.id)).filter(Boolean);
      const groupIds = new Set(memberTabs.map((m) => String(parseViv(m).group || "")));
      let unchanged = false;
      if (groupIds.size === 1) {
        const gid = [...groupIds][0];
        const stack = existing.find((s) => String(s.id) === gid);
        const anchor = memberTabs.find((m) => String(parseViv(m).group) === gid);
        const sameMembers = !!stack && stack.tabIds.length === memberTabs.length && stack.tabIds.every((id) => memberTabs.some((m) => m.id === id));
        const titleOk = !t.name || (anchor && parseViv(anchor).fixedGroupTitle === t.name);
        const colorOk = !t.color || (anchor && parseViv(anchor).groupColor === t.color);
        if (sameMembers && titleOk && colorOk) {
          applied.push({ name: t.name || null, groupExtId: gid, tabIds: memberTabs.map((m) => m.id), unchanged: true });
          unchanged = true;
        }
      }
      if (!unchanged) {
        const res = await groupTabs(memberTabs, { name: t.name, color: t.color });
        applied.push({ name: t.name || null, groupExtId: res.groupExtId, tabIds: memberTabs.map((m) => m.id) });
      }
    }

    layoutRev += 1;
    return { rev: layoutRev, applied, dissolved, skipped };
  };

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
    "layout.apply": (p) => withLock(() => applyLayout(p)),
  };

  const subscribers = new Set(); // extIds that asked for events

  const reply = (sendResponse, id, ok, payload, v) => {
    try { sendResponse({ v: v ?? PROTOCOL_VERSION, id, type: "response", ok, ...payload }); }
    catch { /* port closed before response — nothing to do */ }
  };

  chrome.runtime.onMessageExternal.addListener((env, sender, sendResponse) => {
    if (!env || !PROTOCOL_VERSIONS.includes(env.v)) return; // not ours — stay silent for foreign traffic

    if (env.type !== "request") return;
    // AUTH-CHECK: pairing enforcement was removed for the dev build. When the
    // authentication mechanism lands, reject unauthenticated senders here (the
    // old code returned NOT_PAIRED after isPaired(sender.id)).
    const extId = sender.id;
    const startedAt = Date.now();

    if (env.action === "events.subscribe") {
      subscribers.add(extId);
      logDebug(`events.subscribe from ${extId} (${subscribers.size} subscribed)`);
      reply(sendResponse, env.id, true, { result: { subscribed: true, capabilities: capabilities() } }, env.v);
      return;
    }
    if (env.action === "events.unsubscribe") {
      subscribers.delete(extId);
      logDebug(`events.unsubscribe from ${extId} (${subscribers.size} subscribed)`);
      reply(sendResponse, env.id, true, { result: { subscribed: false } }, env.v);
      return;
    }

    const handler = HANDLERS[env.action];
    if (!handler) {
      logError(`UNKNOWN_ACTION "${env.action}" from ${extId}`);
      reply(sendResponse, env.id, false, { error: { code: "UNKNOWN_ACTION", message: `Unknown action: ${env.action}` } }, env.v);
      return;
    }
    if (env.action === "layout.apply" && env.v !== 2) {
      reply(sendResponse, env.id, false, { error: { code: "WRONG_VERSION", message: "layout.apply requires protocol v2" } }, env.v);
      return;
    }

    logDebug(`→ ${env.action} (id=${env.id}, from=${extId}) ${short(env.params)}`);
    Promise.resolve()
      .then(() => handler(env.params || {}))
      .then((result) => {
        logDebug(`← ok ${env.action} (${Date.now() - startedAt}ms) ${short(result)}`);
        reply(sendResponse, env.id, true, { result }, env.v);
      })
      .catch((e) => {
        logError(`← ${env.action} failed (${e.code || "INTERNAL"}, ${Date.now() - startedAt}ms): ${e.message || e}`, e);
        reply(sendResponse, env.id, false, { error: { code: e.code || "INTERNAL", message: String(e.message || e) } }, env.v);
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
