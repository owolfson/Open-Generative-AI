"use client";

import { BoltIcon } from "./LocalToggle.jsx";
import { useLocalStatus } from "./useLocal.js";

const DOT = { online: "bg-emerald-400", offline: "bg-red-400", loading: "bg-white/30" };

/** Small "⚡ Local" status pill for the app header; opens the local-models settings. Hidden when local inference is not configured. */
export default function LocalHeaderChip({ onClick }) {
  const { phase, health } = useLocalStatus();
  if (phase === "unconfigured") return null;
  const gpu = health ? (health.gpuEnabled ? "GPU jobs on" : "GPU jobs off") : "";
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="local-header-chip"
      title={phase === "online" ? `Local inference online · ${gpu}. Click to manage local models.` : "Local inference is not reachable. Click for details."}
      className="hidden sm:flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/5 hover:bg-white/10 transition-colors"
    >
      <BoltIcon className="text-amber-300" />
      <span className="text-xs font-bold text-white/90">Local</span>
      <span className={`w-2 h-2 rounded-full ${DOT[phase] || DOT.loading}`} />
    </button>
  );
}
