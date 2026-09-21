"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getCatalog, getHealth } from "./localClient.js";

// ── Shared status store: one poller for every ⚡ toggle / panel on the page ─────────────────────────────────────────
const store = {
  state: { phase: "loading", health: null, models: [], excluded: [], error: null, catalogAt: 0 },
  listeners: new Set(),
  timer: null,
};

const setState = (patch) => {
  store.state = { ...store.state, ...patch };
  store.listeners.forEach((fn) => fn());
};

async function poll({ withCatalog = false } = {}) {
  try {
    const health = await getHealth();
    setState({ phase: "online", health, error: null });
    if (withCatalog) {
      const { models, excluded } = await getCatalog();
      setState({ models, excluded: excluded || [], catalogAt: Date.now() });
    }
  } catch (err) {
    setState({ phase: err.code === "LOCAL_NOT_CONFIGURED" ? "unconfigured" : "offline", error: err });
  }
}

/** Re-read the catalog (after a download / delete). */
export const refreshLocalCatalog = () => poll({ withCatalog: true });

function subscribe(fn) {
  store.listeners.add(fn);
  if (store.listeners.size === 1) {
    poll({ withCatalog: true });
    store.timer = setInterval(() => poll({ withCatalog: Date.now() - store.state.catalogAt > 60_000 }), 15_000);
  }
  return () => {
    store.listeners.delete(fn);
    if (store.listeners.size === 0) { clearInterval(store.timer); store.timer = null; }
  };
}

const SERVER_STATE = store.state;

/** phase: loading | online | offline | unconfigured; plus health ({gpuEnabled, allowedDevices}), models, excluded. */
export function useLocalStatus() {
  return useSyncExternalStore(subscribe, () => store.state, () => SERVER_STATE);
}

// ── ⚡ Local mode (shared between the Image and Video studios, survives reloads) ────────────────────────────────────
const MODE_KEY = "ogai_local_mode";
const MODE_EVENT = "ogai-local-mode";

const readMode = () => {
  try { return window.localStorage.getItem(MODE_KEY) === "1"; } catch { return false; }
};

export function useLocalMode() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(readMode());
    sync();
    window.addEventListener(MODE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(MODE_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  const set = useCallback((value) => {
    try { window.localStorage.setItem(MODE_KEY, value ? "1" : "0"); } catch { /* private mode: the toggle just will not persist */ }
    window.dispatchEvent(new Event(MODE_EVENT));
  }, []);
  return [on, set];
}

// ── Local generation history (per browser; the files themselves live on the server) ─────────────────────────────────
const HISTORY_KEY = "ogai_local_history_v1";
const HISTORY_EVENT = "ogai-local-history";

export function readLocalHistory() {
  try { return JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; }
}

export function writeLocalHistory(list) {
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* full or blocked */ }
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

const DISMISSED_KEY = "ogai_local_dismissed_v1";
export function readDismissed() {
  try { return new Set(JSON.parse(window.localStorage.getItem(DISMISSED_KEY) || "[]")); } catch { return new Set(); }
}
/** Remembers an entry the user removed, so syncing with the server's job list does not bring it back. */
export function dismissLocalEntry(id) {
  try { const set = readDismissed(); set.add(id); window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set].slice(-500))); } catch { /* not persisted */ }
}

export function useLocalHistory() {
  const [list, setList] = useState([]);
  useEffect(() => {
    const sync = () => setList(readLocalHistory());
    sync();
    window.addEventListener(HISTORY_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(HISTORY_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return list;
}
