"use client";

import { PROMPT_CONTROL_LABEL_CLASS, promptControlClassName } from "../components/prompt/PromptComposer.jsx";
import { useLocalMode, useLocalStatus } from "./useLocal.js";

export function BoltIcon({ className = "" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

const DOT = { online: "bg-emerald-400", offline: "bg-red-400", loading: "bg-white/30" };

/**
 * ⚡ Local switch for the Image and Video studios. On = the studio shows the local (own-GPU) generator instead of the Muapi
 * cloud one. Renders nothing when this deployment has no local inference service configured.
 */
export default function LocalToggle({ className = "" }) {
  const [on, setOn] = useLocalMode();
  const { phase, health, error } = useLocalStatus();
  if (phase === "unconfigured") return null;

  const title = on
    ? "Local mode: generating on this server's GPUs. Click to go back to the cloud (Muapi) models."
    : phase === "offline"
      ? `Local inference is offline${error ? ` (${error.message})` : ""}. Click to open the local studio anyway.`
      : `Generate on this server's GPUs${health && !health.gpuEnabled ? " (GPU jobs are currently switched off)" : ""}, no API key needed.`;

  return (
    <button
      type="button"
      onClick={() => setOn(!on)}
      title={title}
      aria-pressed={on}
      data-testid="local-toggle"
      className={promptControlClassName({ active: on, compact: true, className })}
    >
      <BoltIcon className={on ? "text-[#22d3ee]" : "text-amber-300"} />
      <span className={PROMPT_CONTROL_LABEL_CLASS}>Local</span>
      <span className={`w-1.5 h-1.5 rounded-full ${DOT[phase] || DOT.loading}`} aria-hidden="true" />
    </button>
  );
}
