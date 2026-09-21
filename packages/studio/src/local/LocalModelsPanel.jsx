"use client";

import { useEffect, useMemo, useState } from "react";
import { BoltIcon } from "./LocalToggle.jsx";
import { invokeIpc, subscribeDownloads } from "./localClient.js";
import { DEVICE_LABEL, explainError, modelReadiness, needsV100 } from "./localLogic.js";
import { refreshLocalCatalog, useLocalStatus } from "./useLocal.js";

const TONE = { ok: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20", warn: "text-amber-300 bg-amber-400/10 border-amber-400/20", muted: "text-white/40 bg-white/5 border-white/10" };
const Pill = ({ children, tone = "muted" }) => <span className={`text-[10px] font-bold px-2 py-0.5 rounded border whitespace-nowrap ${TONE[tone]}`}>{children}</span>;

const isDownloadable = (m) => m.route === "sdcpp" && typeof m.filesPresent !== "boolean" && Boolean(m.downloadUrl);

function ModelRow({ model, busy, progress, onDownload, onDelete }) {
  const ready = modelReadiness(model);
  const downloadable = isDownloadable(model);
  const proven = model.evidence === "proven";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 flex flex-col gap-2" data-testid={`local-model-${model.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-white flex items-center gap-1.5">{model.star && <span className="text-amber-300" title="Recommended">★</span>}<span className="truncate">{model.name}</span></p>
          {model.description || model.note ? <p className="text-[11px] text-white/40 mt-0.5 leading-relaxed">{model.note || model.description}</p> : null}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Pill tone={ready.tone}>{ready.label}</Pill>
          {model.route === "sdcpp" && <Pill>{needsV100(model) ? "V100" : "GTX 1080 or V100"}</Pill>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {model.weightsGb ? <Pill>{Math.round(model.weightsGb * 10) / 10} GB</Pill> : model.sizeGB ? <Pill>{model.sizeGB} GB</Pill> : null}
          {model.route === "sdcpp" && <Pill tone={proven ? "ok" : "muted"}>{proven ? `Proven on ${(model.provenOn || []).map((d) => DEVICE_LABEL[d] || d).join(" + ")}` : "Untested here"}</Pill>}
          {ready.reason && !ready.ready && <span className="text-[10px] text-white/35">{ready.reason}</span>}
        </div>
        {downloadable && (
          <div className="flex items-center gap-2">
            {busy ? (
              <span className="text-[11px] text-[#22d3ee] tabular-nums" data-testid="download-progress">{progress != null ? `Downloading ${Math.round(progress * 100)}%` : "Working…"}</span>
            ) : ready.ready ? (
              <button type="button" onClick={() => onDelete(model)} className="text-[11px] font-bold text-white/40 hover:text-red-300">Delete</button>
            ) : (
              <button type="button" onClick={() => onDownload(model)} className="text-[11px] font-bold px-3 py-1.5 rounded-full bg-[#22d3ee] text-black hover:opacity-90">Download</button>
            )}
          </div>
        )}
      </div>
      {busy && <div className="h-1 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-[#22d3ee] transition-all" style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>}
    </div>
  );
}

/** Settings -> Local Models: what the local inference service can run, what is missing, and download / delete for the downloadable ones. */
export default function LocalModelsPanel() {
  const status = useLocalStatus();
  const [busyId, setBusyId] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => subscribeDownloads((e) => { if (typeof e.progress === "number") setProgress(e.progress); }), []);

  const groups = useMemo(() => [
    ["Image models", status.models.filter((m) => m.kind === "image")],
    ["Video models", status.models.filter((m) => m.kind === "video")],
  ], [status.models]);

  if (status.phase === "unconfigured") return <p className="text-xs text-white/40">Local inference is not configured for this app.</p>;

  const download = async (model) => {
    setError(null); setBusyId(model.id); setProgress(0);
    try {
      await invokeIpc("local-ai:download-model", model.id);
      for (const [key, state] of Object.entries(model.auxiliaryStatus || {})) {
        if (state !== "downloaded") { setProgress(0); await invokeIpc("local-ai:download-auxiliary", key); }
      }
    } catch (err) { setError(explainError(err)); }
    setBusyId(null); setProgress(null); refreshLocalCatalog();
  };

  const remove = async (model) => {
    if (!window.confirm(`Delete ${model.name} from the server? You can download it again later.`)) return;
    setError(null); setBusyId(model.id); setProgress(null);
    try { await invokeIpc("local-ai:delete-model", model.id); } catch (err) { setError(explainError(err)); }
    setBusyId(null); refreshLocalCatalog();
  };

  const { phase, health } = status;
  return (
    <div className="flex flex-col gap-5" data-testid="local-models-panel">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BoltIcon className="text-amber-300" />
          <span className="text-[13px] font-bold text-white">Local inference</span>
          <span className={`w-2 h-2 rounded-full ${phase === "online" ? "bg-emerald-400" : phase === "loading" ? "bg-white/30" : "bg-red-400"}`} />
          <span className="text-[11px] text-white/50">{phase === "online" ? "online" : phase === "loading" ? "checking…" : "not reachable"}</span>
        </div>
        {health && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Pill tone={health.gpuEnabled ? "ok" : "warn"}>{health.gpuEnabled ? "GPU jobs on" : "GPU jobs off"}</Pill>
            {(health.allowedDevices || []).map((d) => <Pill key={d}>{DEVICE_LABEL[d] || d}</Pill>)}
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-[11px] text-red-300/90">{error}</p>}

      {groups.map(([title, list]) => list.length > 0 && (
        <section key={title} className="flex flex-col gap-2.5">
          <h3 className="text-[11px] font-semibold text-white/30 uppercase tracking-wider">{title}</h3>
          {list.map((m) => <ModelRow key={m.id} model={m} busy={busyId === m.id} progress={progress} onDownload={download} onDelete={remove} />)}
        </section>
      ))}

      {status.excluded.length > 0 && (
        <details className="text-[11px] text-white/40">
          <summary className="cursor-pointer font-semibold text-white/50">Not offered on this hardware ({status.excluded.length})</summary>
          <ul className="mt-2 flex flex-col gap-1.5 list-disc pl-4">{status.excluded.map((x) => <li key={x.id}><span className="text-white/60">{x.id}</span> — {x.reason}</li>)}</ul>
        </details>
      )}
      <p className="text-[10px] text-white/25 leading-relaxed">Flux, Qwen-Image and Wan 2.2 are read from the server&apos;s ComfyUI model folders. Z-Image and the Stable Diffusion models can be downloaded here.</p>
    </div>
  );
}
