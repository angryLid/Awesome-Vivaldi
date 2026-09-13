#!/usr/bin/env bash
# bridge.sh — install / uninstall / status for the StackBridge mod.
# Standalone tool: touches ONLY the StackBridge mod. Does not install, remove,
# or otherwise interact with any other Awesome-Vivaldi component.
#
# Supported platforms: macOS, Linux. (Windows is not supported yet.)
#
# Injection model (mirrors the upstream install.sh, narrowed to one mod):
#   1. Locate Vivaldi's resources/vivaldi directory
#   2. Back up window.html once (window.html.bak — never overwritten)
#   3. Ensure <script src="injectMods.js"> is present in window.html
#   4. Deploy injectMods.js (loader, taken from the reference repo when present)
#   5. Copy StackBridge.js into user_mods/js/
#
# Uninstall removes ONLY StackBridge.js. The loader and other mods are left
# untouched. window.html is restored from the backup only if we created it and
# no other mod is installed.

set -u

MOD_NAME="StackBridge.js"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD_SOURCE="$SCRIPT_DIR/mod/$MOD_NAME"
# Reference repository (for injectMods.js when the target has no loader yet).
# Adjust if the reference checkout lives elsewhere.
REFERENCE_REPO="$SCRIPT_DIR/.."

C_G="\033[1;32m"; C_Y="\033[1;33m"; C_R="\033[1;31m"; C_B="\033[0m"
log()  { printf '  %b✓%b %s\n' "$C_G" "$C_B" "$1"; }
warn() { printf '  %b!%b %s\n' "$C_Y" "$C_B" "$1"; }
err()  { printf '  %b✗%b %s\n' "$C_R" "$C_B" "$1" >&2; }
die()  { err "$1"; exit 1; }

usage() {
  cat <<EOF
StackBridge installer

Usage:
  ./bridge.sh install     Deploy StackBridge to discovered Vivaldi installation(s)
  ./bridge.sh uninstall   Remove StackBridge only (loader and other mods untouched)
  ./bridge.sh status      Show what is installed where

Options:
  --path <dir>            Target an explicit Vivaldi resources/vivaldi directory
  -y                      Non-interactive: apply to all discovered installations

Confirmation prompts: Enter = yes, Esc = no.
EOF
}

# ── discovery ──────────────────────────────────────────────────────────────
# Prints "resources_dir|display_name|version" lines.

discover_installations() {
  local found=() seen=()

  add_entry() {
    local resources_dir="$1" name="$2" ver="$3"
    [ -f "$resources_dir/window.html" ] || return 0
    for s in "${seen[@]:-}"; do [ "$s" = "$resources_dir" ] && return 0; done
    seen+=("$resources_dir")
    found+=("$resources_dir|$name|$ver")
  }

  case "$(uname -s)" in
    Darwin)
      local search=("/Applications" "$HOME/Applications")
      [ -n "${VIVALDI_TEST_PATH:-}" ] && search=("$VIVALDI_TEST_PATH")
      while IFS= read -r -d '' fw; do
        local rd="${fw}/Resources/vivaldi"
        [ -f "$rd/window.html" ] || continue
        local app="${fw%%/Contents/Frameworks/Vivaldi Framework.framework*}"
        local nm="Vivaldi"
        case "$(basename "$app")" in *Snapshot*|*snapshot*) nm="Vivaldi Snapshot" ;; esac
        local ver="unknown"
        [ -f "$app/Contents/Info.plist" ] && ver="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist" 2>/dev/null || echo unknown)"
        add_entry "$rd" "$nm" "$ver"
      done < <(find "${search[@]}" -type d -name "Vivaldi Framework.framework" -print0 2>/dev/null)
      ;;
    Linux)
      local entries=(
        "/opt/vivaldi|Vivaldi"
        "/opt/vivaldi-snapshot|Vivaldi Snapshot"
        "/usr/share/vivaldi|Vivaldi"
        "/usr/lib/vivaldi|Vivaldi"
        "$HOME/.local/share/flatpak/app/com.vivaldi.Vivaldi/current/active/files/extra/opt/vivaldi|Vivaldi (Flatpak)"
        "/var/lib/flatpak/app/com.vivaldi.Vivaldi/current/active/files/extra/opt/vivaldi|Vivaldi (Flatpak System)"
      )
      [ -n "${VIVALDI_TEST_PATH:-}" ] && entries=("$VIVALDI_TEST_PATH|Vivaldi")
      for e in "${entries[@]}"; do
        local ap="${e%%|*}" nm="${e#*|}"
        [ -f "$ap/resources/vivaldi/window.html" ] || continue
        local ver="unknown"
        [ -x "$ap/vivaldi" ] && ver="$("$ap/vivaldi" --version 2>/dev/null | awk '{print $2}' || echo unknown)"
        add_entry "$ap/resources/vivaldi" "$nm" "$ver"
      done
      ;;
    *) die "Unsupported platform: $(uname -s) (Windows is not supported yet)" ;;
  esac

  printf '%s\n' "${found[@]:-}"
}

resolve_targets() {
  if [ -n "${OPT_PATH:-}" ]; then
    [ -f "$OPT_PATH/window.html" ] || die "No window.html at $OPT_PATH"
    printf '%s|explicit|unknown\n' "$OPT_PATH"
    return
  fi
  discover_installations
}

# Actual write test: cp/rm/sed -i only need write access to the directory
# itself (sed -i renames a temp file over the target), not to window.html.
writable() { { : > "$1/.bridge-write-test"; } 2>/dev/null && rm -f "$1/.bridge-write-test"; }

# ── window.html surgery (single-mod scope) ─────────────────────────────────

ensure_backup() {
  local html="$1"
  [ -f "${html}.bak" ] && return 0
  cp "$html" "${html}.bak" && log "Backed up window.html → window.html.bak"
}

ensure_loader() {
  local vd="$1" html="$1/window.html"
  if grep -q 'injectMods\.js' "$html" 2>/dev/null; then
    log "Mod loader (injectMods.js) already present"
    return 0
  fi
  if [ ! -f "$vd/injectMods.js" ]; then
    local src="$REFERENCE_REPO/injectMods.js"
    [ -f "$src" ] || { warn "injectMods.js not found — cannot bootstrap loader"; return 1; }
    cp "$src" "$vd/injectMods.js" || return 1
    log "Deployed injectMods.js from reference repo"
  fi
  # BSD sed (macOS) needs -i ''; GNU sed needs -i. Try BSD form first, fall back.
  { sed -i '' '/<body[^>]*>/a\
  <script src="injectMods.js"></script>' "$html" 2>/dev/null; } \
  || { sed -i '/<body[^>]*>/a\  <script src="injectMods.js"></script>' "$html" 2>/dev/null; } \
  || return 1
  grep -q 'injectMods\.js' "$html" || return 1
  log "Injected <script src=\"injectMods.js\"> into window.html"
}

deploy_mod() {
  local vd="$1"
  mkdir -p "$vd/user_mods/js" || return 1
  cp "$MOD_SOURCE" "$vd/user_mods/js/$MOD_NAME" || return 1
  log "Deployed $MOD_NAME → user_mods/js/"
}

# ── restart support (ported from install.sh post_install) ───────────────

is_running() {
  if [ "$(uname -s)" = "Darwin" ]; then pgrep -q Vivaldi 2>/dev/null; else pgrep -f vivaldi >/dev/null 2>&1; fi
}

stop_vivaldi() {
  if [ "$(uname -s)" = "Darwin" ]; then pkill Vivaldi 2>/dev/null || true; else pkill -f vivaldi 2>/dev/null || true; fi
  local waited=0
  while is_running && [ "$waited" -lt 25 ]; do sleep 0.2; waited=$((waited + 1)); done
  sleep 0.3
}

launch_vivaldi() {
  case "$(uname -s)" in
    Darwin)
      local app="${APPLIED_VD%%/Contents/Frameworks/Vivaldi Framework.framework*}"
      open "$app" --args --debug-packed-apps --silent-debugger-extension-api 2>/dev/null || open -a Vivaldi
      ;;
    Linux)
      case "$APPLIED_VD" in
        *flatpak*) nohup flatpak run com.vivaldi.Vivaldi --debug-packed-apps --silent-debugger-extension-api >/dev/null 2>&1 & return 0 ;;
      esac
      local app_dir; app_dir="$(dirname "$(dirname "$APPLIED_VD")")"
      local bin="vivaldi"
      [ -x "$app_dir/vivaldi" ] && bin="$app_dir/vivaldi"
      command -v "$bin" >/dev/null 2>&1 || { command -v vivaldi-stable >/dev/null 2>&1 && bin="vivaldi-stable"; }
      nohup "$bin" --debug-packed-apps --silent-debugger-extension-api >/dev/null 2>&1 &
      ;;
  esac
}

# Single-key confirm: Enter = yes, Esc = no. Other keys are ignored; EOF or a
# non-interactive stdin answers "no". With -y it answers yes without prompting.
ask_yn() {
  local prompt="$1" key=""
  [ "$ASSUME_YES" -eq 1 ] && return 0
  if [ ! -t 0 ]; then printf '  %s (no tty — answering No)\n' "$prompt"; return 1; fi
  printf '  %s %b[Enter]%b=Yes  %b[Esc]%b=No ' "$prompt" "$C_G" "$C_B" "$C_R" "$C_B"
  while IFS= read -rsn1 key; do
    case "$key" in
      "")    echo; return 0 ;;
      $'\e') echo; return 1 ;;
    esac
  done
  echo
  return 1
}

# Ask (or with -y, assume yes) to restart Vivaldi after a successful apply.
offer_restart() {
  if [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" != "Darwin" ] && [ -z "${SUDO_USER:-}" ]; then
    log "Running as root — restart Vivaldi manually from your user session."
    return 0
  fi
  if is_running; then
    if ask_yn "Restart Vivaldi now?"; then
      echo "  Restarting Vivaldi..."
      stop_vivaldi
      launch_vivaldi
      log "Vivaldi restarted."
    else
      log "Skipped — restart Vivaldi to apply."
    fi
  else
    if ask_yn "Vivaldi is not running. Launch it now?"; then
      launch_vivaldi
      log "Vivaldi launched."
    else
      log "Skipped — launch Vivaldi to apply."
    fi
  fi
}

# ── commands ───────────────────────────────────────────────────────────────

cmd_install() {
  [ -f "$MOD_SOURCE" ] || die "Mod source missing: $MOD_SOURCE"
  local targets; targets="$(resolve_targets)" || die "Discovery failed"
  [ -z "$targets" ] && die "No Vivaldi installation found (set --path or VIVALDI_TEST_PATH to override)"

  local count=0 applied=0
  while IFS='|' read -r vd name ver; do
    [ -z "$vd" ] && continue
    count=$((count + 1))
    echo ""
    printf '%b▸%b %s %s — %s\n' "$C_B" "$C_B" "$name" "$ver" "$vd"
    if ! writable "$vd"; then
      err "No write permission (try sudo, or fix ownership of $vd)"
      continue
    fi
    ensure_backup "$vd/window.html"
    if ensure_loader "$vd" && deploy_mod "$vd"; then
      applied=$((applied + 1))
      APPLIED_VD="$vd"
    else
      err "Deployment failed for $vd"
    fi
  done <<< "$targets"

  echo ""
  [ "$applied" -eq 0 ] && die "Nothing was installed"
  log "StackBridge installed to $applied/$count installation(s)."
  offer_restart
  echo "
  Next steps:
    1. Open vivaldi:inspect/#apps → inspect window.html → console shows: [StackBridge] Ready
    2. Run: chrome.runtime.id   (Vivaldi 8.2.4133.52 → mpognobbkildjkofajifpdfhcoklimli;
       verify before hardcoding into your extension manifest)
    3. No pairing needed in this dev build — any extension can call all actions.
    4. Full protocol: see Bridge/API.md"
}

cmd_uninstall() {
  local targets; targets="$(resolve_targets)" || die "Discovery failed"
  [ -z "$targets" ] && die "No Vivaldi installation found"

  local count=0 applied=0
  while IFS='|' read -r vd name ver; do
    [ -z "$vd" ] && continue
    count=$((count + 1))
    echo ""
    printf '%b▸%b %s %s — %s\n' "$C_B" "$C_B" "$name" "$ver" "$vd"
    local js="$vd/user_mods/js/$MOD_NAME"
    if [ ! -f "$js" ]; then
      warn "Not installed here"
      continue
    fi
    if ! writable "$vd"; then
      err "No write permission on $vd"
      continue
    fi
    rm -f "$js" && applied=$((applied + 1))
    APPLIED_VD="$vd"
    log "Removed $MOD_NAME"

    # Restore window.html ONLY if this install now has zero JS mods and we own the backup.
    local others=0
    for f in "$vd/user_mods/js/"*.js; do [ -f "$f" ] && others=$((others + 1)); done
    if [ "$others" -eq 0 ] && [ -f "$vd/window.html.bak" ] && grep -q 'injectMods\.js' "$vd/window.html"; then
      cp "$vd/window.html.bak" "$vd/window.html" && rm -f "$vd/injectMods.js"
      log "No mods remain — restored window.html and removed loader"
    else
      [ "$others" -gt 0 ] && warn "Other mods still present — loader kept"
    fi
  done <<< "$targets"

  echo ""
  [ "$applied" -eq 0 ] && die "Nothing was uninstalled"
  log "StackBridge removed from $applied/$count installation(s)."
  offer_restart
}

cmd_status() {
  local targets; targets="$(resolve_targets)" || true
  [ -z "$targets" ] && die "No Vivaldi installation found"
  while IFS='|' read -r vd name ver; do
    [ -z "$vd" ] && continue
    echo ""
    printf '%b▸%b %s %s\n' "$C_B" "$C_B" "$name" "$ver"
    echo "    path: $vd"
    if [ -f "$vd/user_mods/js/$MOD_NAME" ]; then
      local installed deployed
      installed="$(stat -c %y "$vd/user_mods/js/$MOD_NAME" 2>/dev/null || stat -f '%Sm' "$vd/user_mods/js/$MOD_NAME" 2>/dev/null || echo unknown)"
      deployed="$(cmp -s "$MOD_SOURCE" "$vd/user_mods/js/$MOD_NAME" && echo "up to date" || echo "OUTDATED (differs from $MOD_SOURCE)")"
      echo "    mod:    installed ($installed)"
      echo "            $deployed"
    else
      echo "    mod:    not installed"
    fi
    if grep -q 'injectMods\.js' "$vd/window.html" 2>/dev/null; then
      echo "    loader: injected"
    else
      echo "    loader: missing"
    fi
  done <<< "$targets"
  echo ""
}

# ── entry ──────────────────────────────────────────────────────────────────

OPT_PATH=""; CMD=""; ASSUME_YES=0; APPLIED_VD=""
while [ $# -gt 0 ]; do
  case "$1" in
    install|uninstall|status) CMD="$1" ;;
    --path) OPT_PATH="${2:-}"; shift ;;
    -y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown argument: $1" ;;
  esac
  shift
done
[ -z "$CMD" ] && { usage; die "No command given"; }

echo "StackBridge installer ($CMD)"
if [ "$CMD" != "status" ]; then
  ask_yn "Continue?" || { echo "Aborted."; exit 0; }
fi

"cmd_$CMD"
