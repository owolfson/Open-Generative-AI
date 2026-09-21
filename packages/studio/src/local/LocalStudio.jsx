"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PROMPT_CONTROL_LABEL_CLASS,
  PROMPT_MEDIA_PREVIEW_CLASS,
  PromptAction,
  PromptAspectRatioIcon,
  PromptChevronIcon,
  PromptComposer,
  PromptControls,
  PromptFooter,
  PromptMenuItem,
  PromptMenuList,
  PromptPopover,
  PromptPopoverHeader,
  PromptTextarea,
  promptControlClassName,
  promptMediaButtonClassName,
} from "../components/prompt/PromptComposer.jsx";
import LocalToggle, { BoltIcon } from "./LocalToggle.jsx";
import { cancelJob, listJobs, submitJob, urlToBase64, blobToBase64, waitForJob } from "./localClient.js";
import {
  DEVICE_LABEL,
  V100_WARNING,
  aspectsFor,
  buildParams,
  describeJob,
  explainError,
  formatDuration,
  needsV100,
  pickerModels,
  proxyUrl,
  pushHistory,
  resolveDevice,
} from "./localLogic.js";
import { readLocalHistory, useLocalHistory, useLocalStatus, writeLocalHistory } from "./useLocal.js";

const PREFS_KEY = "ogai_local_prefs_v1";
const VIDEO_SOURCE_KEY = "ogai_local_video_source";
const FRAME_CHOICES = [17, 25, 33];   // 33 is the longest measured on the V100 (the 3D-VAE decode is what runs out of memory)

const loadPrefs = () => { try { return JSON.parse(window.localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; } };
const savePrefs = (kind, patch) => {
  try { const all = loadPrefs(); window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...all, [kind]: { ...(all[kind] || {}), ...patch } })); } catch { /* not persisted */ }
};

const TONE = { ok: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20", warn: "text-amber-300 bg-amber-400/10 border-amber-400/20", muted: "text-white/40 bg-white/5 border-white/10" };

const Badge = ({ children, tone = "muted", title }) => (
  <span title={title} className={`text-[10px] font-bold px-2 py-0.5 rounded border whitespace-nowrap ${TONE[tone]}`}>{children}</span>
);

const evidenceText = (m) => (m.evidence === "proven" ? `Proven on ${(m.provenOn || []).map((d) => DEVICE_LABEL[d] || d).join(" + ")}` : "Untested here");

function StatusBanner({ status, onRetry }) {
  const { phase, health, error } = status;
  if (phase === "loading") return null;
  let text = null; let tone = "warn";
  if (phase === "offline") text = `The local inference service is not reachable${error ? ` (${error.message})` : ""}.`;
  else if (phase === "online" && health && !health.gpuEnabled) text = "GPU jobs are switched off on the local service (OGAI_GPU_ENABLED). Nothing can be generated until they are enabled.";
  if (!text) return null;
  return (
    <div role="alert" className={`w-full max-w-3xl mx-auto mb-3 px-4 py-2.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${TONE[tone]}`}>
      <span>{text}</span>
      {phase === "offline" && <button type="button" onClick={onRetry} className="font-bold underline underline-offset-2 shrink-0">Retry</button>}
    </div>
  );
}

function RunningCard({ active, job, now, kind, onCancel }) {
  const elapsed = now - active.startedAt;
  const { text, pct } = describeJob(job, { device: active.device, elapsedMs: elapsed, kind });
  return (
    <div data-testid="local-running" className="rounded-lg border border-[#22d3ee]/25 bg-[#0a0a0a] p-4 flex flex-col gap-3 animate-fade-in-up">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <BoltIcon className="text-[#22d3ee] animate-pulse shrink-0" />
          <span className="text-xs font-bold text-white truncate">{active.modelName}</span>
          <Badge tone={active.device === "v100" ? "warn" : "muted"}>{DEVICE_LABEL[active.device]}</Badge>
        </div>
        <span className="text-[11px] tabular-nums text-white/40">{formatDuration(elapsed)}</span>
      </div>
      <p className="text-[11px] text-white/50 line-clamp-2">{active.prompt}</p>
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={`h-full bg-[#22d3ee] transition-all duration-500 ${pct === null ? "w-1/3 animate-pulse" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-white/60">{text}</span>
        <button type="button" onClick={onCancel} className="text-[11px] font-bold text-red-300/80 hover:text-red-300">Cancel</button>
      </div>
    </div>
  );
}

function MediaCard({ entry, onOpen, onRemove, onAnimate }) {
  const isVideo = entry.kind === "video";
  return (
    <div className="relative group rounded-lg overflow-hidden border border-white/10 bg-[#0a0a0a] shadow-xl hover:border-primary/50 transition-all duration-300 flex flex-col cursor-pointer" onClick={() => onOpen(entry)}>
      {isVideo ? (
        <video src={entry.url} muted loop playsInline preload="metadata" className="w-full aspect-video object-cover bg-black/40"
          onMouseEnter={(e) => e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => { e.currentTarget.pause(); }} />
      ) : (
        <img src={entry.url} alt={entry.prompt.slice(0, 40)} className="w-full aspect-square object-cover bg-black/40 hover:opacity-80 transition-opacity" />
      )}
      <div className="absolute top-2 right-2 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
        <a href={entry.url} download className="w-8 h-8 rounded-full bg-black/60 hover:bg-black text-white/80 hover:text-white flex items-center justify-center" title="Download" aria-label="Download">↓</a>
        {!isVideo && <button type="button" onClick={() => onAnimate(entry)} className="w-8 h-8 rounded-full bg-black/60 hover:bg-black text-[#22d3ee] flex items-center justify-center" title="Animate with Wan 2.2" aria-label="Animate">▶</button>}
        <button type="button" onClick={() => onRemove(entry)} className="w-8 h-8 rounded-full bg-black/60 hover:bg-black text-white/60 hover:text-red-300 flex items-center justify-center" title="Remove from history" aria-label="Remove">×</button>
      </div>
      <div className="p-3 flex flex-col gap-1.5">
        <p className="text-[11px] text-white/70 line-clamp-2">{entry.prompt}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-bold text-primary px-2 py-0.5 bg-primary/10 rounded border border-primary/20">{entry.modelName}</span>
          <span className="text-[10px] text-white/40">{DEVICE_LABEL[entry.device] || entry.device}</span>
          {entry.seconds ? <span className="text-[10px] text-white/30">{formatDuration(entry.seconds * 1000)}</span> : null}
        </div>
      </div>
    </div>
  );
}

function Viewer({ entry, onClose, onAnimate }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex flex-col items-center justify-center p-4 gap-4" onClick={onClose} role="dialog" aria-modal="true">
      <button type="button" onClick={onClose} aria-label="Close" className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-xl">×</button>
      <div className="max-w-[92vw] max-h-[74vh] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {entry.kind === "video"
          ? <video src={entry.url} controls autoPlay loop playsInline className="max-w-[92vw] max-h-[74vh] rounded-lg" />
          : <img src={entry.url} alt={entry.prompt.slice(0, 40)} className="max-w-[92vw] max-h-[74vh] rounded-lg object-contain" />}
      </div>
      <div className="max-w-2xl text-center flex flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm text-white/80">{entry.prompt}</p>
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <Badge tone="ok">{entry.modelName}</Badge>
          <Badge>{DEVICE_LABEL[entry.device] || entry.device}</Badge>
          {entry.seed ? <Badge>seed {entry.seed}</Badge> : null}
          {entry.seconds ? <Badge>{formatDuration(entry.seconds * 1000)}</Badge> : null}
        </div>
        <div className="flex gap-2 mt-1">
          <a href={entry.url} download className="px-4 py-2 rounded-full bg-[#22d3ee] text-black text-xs font-bold">Download</a>
          {entry.kind === "image" && <button type="button" onClick={() => onAnimate(entry)} className="px-4 py-2 rounded-full border border-[#22d3ee]/40 text-[#22d3ee] text-xs font-bold">Animate with Wan 2.2</button>}
        </div>
      </div>
    </div>
  );
}

function ConfirmV100({ onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm flex items-center justify-center px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-xl border border-amber-400/30 bg-[#0a0a0a] p-6 flex flex-col gap-4 shadow-2xl">
        <h2 className="text-base font-bold text-white flex items-center gap-2"><BoltIcon className="text-amber-300" /> Run on the Tesla V100?</h2>
        <p className="text-xs text-white/60 leading-relaxed">{V100_WARNING} Other Hermes features that depend on them will be unavailable until the job finishes and they restart.</p>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-full text-xs font-bold text-white/60 hover:text-white">Cancel</button>
          <button type="button" data-testid="confirm-v100" onClick={onConfirm} className="px-4 py-2 rounded-full bg-amber-300 text-black text-xs font-bold">Run on V100</button>
        </div>
      </div>
    </div>
  );
}

const Field = ({ label, children }) => (
  <label className="flex flex-col gap-1 text-[10px] font-semibold text-white/40 uppercase tracking-wider">
    {label}
    {children}
  </label>
);
const inputClass = "bg-white/5 border border-white/10 rounded-md px-2.5 py-1.5 text-xs text-white normal-case tracking-normal placeholder:text-white/20 focus:outline-none focus:border-[#22d3ee]/40";

export default function LocalStudio({ kind = "image", onGenerationStart, onGenerationEnd, onGenerationComplete, onGenerationError }) {
  const status = useLocalStatus();
  const allHistory = useLocalHistory();
  const history = useMemo(() => allHistory.filter((e) => e.kind === kind), [allHistory, kind]);
  const models = useMemo(() => pickerModels(status.models, kind), [status.models, kind]);

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [modelId, setModelId] = useState(null);
  const [aspect, setAspect] = useState("1:1");
  const [deviceChoice, setDeviceChoice] = useState("auto");
  const [advanced, setAdvanced] = useState({ steps: "", guidance: "", seed: "", frames: 33, fast: true });
  const [source, setSource] = useState(null);          // video: { url, file?, label }
  const [open, setOpen] = useState(null);              // model | aspect | device | advanced | source
  const [active, setActive] = useState(null);          // the running job's tracking info
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [now, setNow] = useState(Date.now());
  const v100Confirmed = useRef(false);
  const abortRef = useRef(null);
  const fileRef = useRef(null);
  const promptRef = useRef(null);
  const busy = Boolean(active);

  // Restore the last-used model / ratio / device for this studio, then fall back to the best model that will not evict the brain.
  useEffect(() => {
    const p = loadPrefs()[kind] || {};
    if (p.aspect) setAspect(p.aspect);
    if (p.device) setDeviceChoice(p.device);
    if (p.model) setModelId(p.model);
  }, [kind]);

  const model = useMemo(() => {
    const chosen = models.find((m) => m.id === modelId);
    if (chosen) return chosen;
    return models.find((m) => m.readiness.ready && !needsV100(m)) || models.find((m) => m.readiness.ready) || models[0] || null;
  }, [models, modelId]);

  const aspects = model ? aspectsFor(model) : ["1:1"];
  useEffect(() => { if (model && !aspects.includes(aspect)) setAspect(aspects[0]); }, [model, aspects, aspect]);

  const device = model ? resolveDevice(model, deviceChoice, status.health) : null;
  const v100Run = Boolean(device && device.v100);

  // Close popovers on an outside click; tick a clock while a job runs.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // "Animate" from an image (in either studio) leaves the chosen frame here for the video studio.
  useEffect(() => {
    if (kind !== "video") return;
    try {
      const raw = window.sessionStorage.getItem(VIDEO_SOURCE_KEY);
      if (!raw) return;
      window.sessionStorage.removeItem(VIDEO_SOURCE_KEY);
      const { url, prompt: p } = JSON.parse(raw);
      setSource({ url, label: "Selected image" });
      if (p) setPrompt((cur) => cur || p);
    } catch { /* ignore */ }
  }, [kind]);

  const finish = useCallback((done, meta) => {
    if (done.status === "cancelled") return;
    if (done.status !== "done" || !done.result) {
      const err = Object.assign(new Error((done.error && done.error.message) || "Generation failed"), { code: done.error && done.error.code });
      throw err;
    }
    const entry = {
      id: done.id, kind: meta.kind, url: proxyUrl(done.result.url), prompt: meta.prompt, model: meta.model, modelName: meta.modelName,
      device: meta.device, aspect: meta.aspect, seed: done.result.seed, seconds: Math.round(((done.finishedAt || Date.now()) - (done.startedAt || meta.startedAt)) / 1000), createdAt: Date.now(),
    };
    writeLocalHistory(pushHistory(readLocalHistory(), entry));
    onGenerationComplete?.({ url: entry.url, model: entry.model, prompt: entry.prompt, type: entry.kind });
  }, [onGenerationComplete]);

  const track = useCallback(async (started, meta) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setActive({ id: started.id, ...meta });
    setJob(started);
    try {
      const done = await waitForJob(started.id, { onUpdate: setJob, signal: controller.signal });
      finish(done, meta);
    } catch (err) {
      if (err.code !== "ABORTED") { const message = explainError(err); setError(message); onGenerationError?.(message); }
    } finally {
      abortRef.current = null; setActive(null); setJob(null); onGenerationEnd?.();
    }
  }, [finish, onGenerationEnd, onGenerationError]);

  // A job already running (page reload, second tab): pick it up instead of showing an idle studio.
  useEffect(() => {
    if (status.phase !== "online") return undefined;
    let cancelled = false;
    listJobs().then((jobs) => {
      const running = jobs.find((j) => (j.status === "running" || j.status === "queued") && j.kind === kind);
      if (!running || cancelled || abortRef.current) return;
      const params = running.params || {};
      const m = status.models.find((x) => x.id === params.model);
      onGenerationStart?.();
      track(running, { kind, prompt: params.prompt || "", model: params.model, modelName: (m && m.name) || params.model, device: params.device || "gtx1080", aspect: params.aspect_ratio || "1:1", startedAt: running.startedAt || Date.now() });
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.phase, kind]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const go = async () => {
    setError(null);
    let imageBase64;
    try {
      if (kind === "video") imageBase64 = source.file ? await blobToBase64(source.file) : await urlToBase64(source.url);
      const params = buildParams({ model, prompt, negative, aspect, device: device.device, advanced, imageBase64 });
      onGenerationStart?.();
      const started = await submitJob(params);
      await track(started, { kind, prompt: prompt.trim(), model: model.id, modelName: model.name, device: device.device, aspect, startedAt: Date.now() });
    } catch (err) {
      const message = explainError(err); setError(message); onGenerationError?.(message); onGenerationEnd?.();
    }
  };

  const handleGenerate = () => {
    if (busy || !model) return;
    if (!prompt.trim()) { setError("Enter a prompt first."); promptRef.current?.focus(); return; }
    if (!model.readiness.ready) { setError(`${model.name}: ${model.readiness.reason || model.readiness.label}`); return; }
    if (device.error) { setError(device.error); return; }
    if (kind === "video" && !source) { setError("Choose a starting image first (upload one or pick a recent local image)."); setOpen("source"); return; }
    if (device.v100 && !v100Confirmed.current) { setConfirm(true); return; }
    go();
  };

  const handleCancel = async () => {
    if (!active) return;
    try { await cancelJob(active.id); } catch (err) { setError(explainError(err)); }
  };

  const animate = (entry) => {
    try { window.sessionStorage.setItem(VIDEO_SOURCE_KEY, JSON.stringify({ url: entry.url, prompt: entry.prompt })); } catch { /* ignore */ }
    setViewer(null);
    if (kind === "video") { setSource({ url: entry.url, label: "Selected image" }); return; }
    window.dispatchEvent(new CustomEvent("ogai-local-navigate", { detail: { tab: "video" } }));
  };

  const removeEntry = (entry) => writeLocalHistory(readLocalHistory().filter((e) => e.id !== entry.id));
  const recentImages = useMemo(() => allHistory.filter((e) => e.kind === "image").slice(0, 8), [allHistory]);
  const stop = (e) => e.stopPropagation();
  const toggle = (name) => (e) => { e.stopPropagation(); setOpen((o) => (o === name ? null : name)); };
  const pickModel = (m) => { setModelId(m.id); savePrefs(kind, { model: m.id }); setOpen(null); };

  const deviceLabel = deviceChoice === "auto" ? `Auto${device && device.device ? ` · ${DEVICE_LABEL[device.device]}` : ""}` : DEVICE_LABEL[deviceChoice];
  const allowed = (status.health && status.health.allowedDevices) || [];

  return (
    <div data-testid="local-studio" className="w-full h-full flex flex-col items-center justify-center bg-app-bg relative p-4 md:p-6 overflow-hidden">
      <div className="flex-1 w-full max-w-7xl mx-auto overflow-y-auto custom-scrollbar pb-44 lg:pb-36 px-2">
        <StatusBanner status={status} onRetry={() => window.location.reload()} />
        {(active || history.length > 0) ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 w-full pt-4">
            {active && <RunningCard active={active} job={job} now={now} kind={kind} onCancel={handleCancel} />}
            {history.map((entry) => <MediaCard key={entry.id} entry={entry} onOpen={setViewer} onRemove={removeEntry} onAnimate={animate} />)}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full animate-fade-in-up min-h-[50vh]">
            <div className="w-20 h-20 rounded-3xl border border-[#22d3ee]/20 bg-[#22d3ee]/5 flex items-center justify-center mb-8"><BoltIcon className="text-[#22d3ee] scale-[2.2]" /></div>
            <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight mb-4 text-center px-4 flex flex-col items-center">
              <span className="text-white font-black uppercase text-xl sm:text-3xl tracking-wide mb-1 opacity-90">{kind === "video" ? "Animate locally with" : "Create locally with"}</span>
              <span className="text-[#22d3ee] font-black uppercase text-2xl sm:text-4xl sm:mt-1 tracking-tight">{model ? model.name : "your GPUs"}</span>
            </h1>
            <p className="text-white/40 text-xs sm:text-sm font-medium tracking-wide text-center max-w-lg leading-relaxed px-4">
              Runs on this server&apos;s own GPUs — no API key, no per-image cost.{kind === "video" ? " Wan 2.2 turns a still image into a short clip." : ""}
            </p>
            {models.length === 0 && status.phase === "online" && <p className="mt-4 text-xs text-amber-300">No local {kind} models are available on this server.</p>}
          </div>
        )}
      </div>

      <PromptComposer>
        <div className="flex flex-col gap-3">
          {v100Run && <p className="text-[11px] text-amber-300/90 px-1" data-testid="v100-note">⚠ {V100_WARNING}</p>}
          <div className="flex items-center gap-2.5 flex-wrap">
            {kind === "video" && (
              <div className="relative" onClick={stop}>
                {source ? (
                  <div className={PROMPT_MEDIA_PREVIEW_CLASS}>
                    <img src={source.url} alt="" className="w-full h-full object-cover" />
                    <button type="button" onClick={() => setSource(null)} aria-label="Remove source image" className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 hover:bg-black rounded-full flex items-center justify-center text-white/85 text-[8px] border border-white/5">×</button>
                  </div>
                ) : (
                  <button type="button" onClick={toggle("source")} title="Starting image" aria-label="Choose a starting image" data-testid="source-button" className={promptMediaButtonClassName({ active: open === "source" })}>
                    <span className="text-white/60 text-lg leading-none">+</span>
                  </button>
                )}
                {open === "source" && (
                  <PromptPopover onClick={stop} className="w-[calc(100vw-2rem)] md:w-[360px]">
                    <PromptPopoverHeader>Starting image</PromptPopoverHeader>
                    <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => {
                      const file = e.target.files && e.target.files[0];
                      if (file) { setSource({ url: URL.createObjectURL(file), file, label: file.name }); setOpen(null); }
                      e.target.value = "";
                    }} />
                    <button type="button" onClick={() => fileRef.current?.click()} className="w-full px-3 py-2.5 rounded-xl border border-dashed border-white/15 text-xs font-semibold text-white/70 hover:border-[#22d3ee]/40 hover:text-[#22d3ee] mb-3">Upload an image (PNG / JPEG)</button>
                    {recentImages.length > 0 ? (
                      <>
                        <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider mb-2 px-1">Recent local images</p>
                        <div className="grid grid-cols-4 gap-2">
                          {recentImages.map((e) => (
                            <button key={e.id} type="button" onClick={() => { setSource({ url: e.url, label: "Local image" }); if (!prompt) setPrompt(e.prompt); setOpen(null); }} className="aspect-square rounded-lg overflow-hidden border border-white/10 hover:border-[#22d3ee]/50">
                              <img src={e.url} alt="" className="w-full h-full object-cover" />
                            </button>
                          ))}
                        </div>
                      </>
                    ) : <p className="text-[11px] text-white/30 px-1">Generate an image in the Image Studio first, or upload one.</p>}
                  </PromptPopover>
                )}
              </div>
            )}
            <PromptTextarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
              placeholder={kind === "video" ? "Describe how the image should move" : "Describe the image you want to create"}
              className="flex-1 min-w-[200px]"
              disabled={busy}
              data-testid="local-prompt"
            />
          </div>
          {error && <p role="alert" data-testid="local-error" className="text-[11px] text-red-300/90 px-1">{error}</p>}
        </div>

        <PromptFooter>
          <PromptControls>
            <LocalToggle />

            <div className="relative" onClick={stop}>
              <button type="button" onClick={toggle("model")} data-testid="model-button" className={promptControlClassName({ active: open === "model" })}>
                <span className={`${PROMPT_CONTROL_LABEL_CLASS} max-w-[180px] truncate`}>{model ? model.name : "No models"}</span>
                <PromptChevronIcon />
              </button>
              {open === "model" && (
                <PromptPopover onClick={stop} className="w-[calc(100vw-2rem)] md:w-[420px] max-h-[60vh]">
                  <PromptPopoverHeader>Local {kind} models</PromptPopoverHeader>
                  <PromptMenuList>
                    {models.map((m) => (
                      <PromptMenuItem key={m.id} selected={model && m.id === model.id} disabled={!m.readiness.ready} onClick={() => pickModel(m)} wrapDescription
                        className={m.readiness.ready ? "" : "opacity-50 cursor-not-allowed"}
                        description={`${m.weightsGb ? `${Math.round(m.weightsGb)} GB · ` : ""}${needsV100(m) ? "V100" : "GTX 1080"} · ${m.readiness.label} · ${evidenceText(m)}`}>
                        {m.star ? "★ " : ""}{m.name}
                      </PromptMenuItem>
                    ))}
                    {models.length === 0 && <p className="text-[11px] text-white/40 px-2 py-3">No local {kind} models are available.</p>}
                  </PromptMenuList>
                </PromptPopover>
              )}
            </div>

            <div className="relative" onClick={stop}>
              <button type="button" onClick={toggle("aspect")} className={promptControlClassName({ active: open === "aspect" })}>
                <PromptAspectRatioIcon />
                <span className={PROMPT_CONTROL_LABEL_CLASS}>{aspect}</span>
              </button>
              {open === "aspect" && (
                <PromptPopover onClick={stop}>
                  <PromptPopoverHeader>Aspect ratio</PromptPopoverHeader>
                  <PromptMenuList>
                    {aspects.map((a) => <PromptMenuItem key={a} selected={a === aspect} onClick={() => { setAspect(a); savePrefs(kind, { aspect: a }); setOpen(null); }}>{a}</PromptMenuItem>)}
                  </PromptMenuList>
                </PromptPopover>
              )}
            </div>

            <div className="relative" onClick={stop}>
              <button type="button" onClick={toggle("device")} data-testid="device-button" className={promptControlClassName({ active: open === "device" })}>
                <span className={PROMPT_CONTROL_LABEL_CLASS}>{deviceLabel}</span>
                <PromptChevronIcon />
              </button>
              {open === "device" && (
                <PromptPopover onClick={stop} className="w-[calc(100vw-2rem)] md:w-[340px]">
                  <PromptPopoverHeader>GPU</PromptPopoverHeader>
                  <PromptMenuList>
                    {[["auto", "Auto", "GTX 1080 for small models; the V100 only when a model needs it"], ["gtx1080", "GTX 1080", "8 GB · never interrupts Hermes"], ["v100", "Tesla V100", "32 GB · stops the Hermes brain (~5 min) and TTS (~7 min)"]].map(([id, label, desc]) => (
                      <PromptMenuItem key={id} selected={id === deviceChoice} wrapDescription description={desc}
                        disabled={id !== "auto" && !allowed.includes(id)} className={id !== "auto" && !allowed.includes(id) ? "opacity-50 cursor-not-allowed" : ""}
                        onClick={() => { setDeviceChoice(id); savePrefs(kind, { device: id }); setOpen(null); }}>{label}</PromptMenuItem>
                    ))}
                  </PromptMenuList>
                </PromptPopover>
              )}
            </div>

            <div className="relative" onClick={stop}>
              <button type="button" onClick={toggle("advanced")} title="Advanced" aria-label="Advanced settings" className={promptControlClassName({ active: open === "advanced", iconOnly: true })}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
              </button>
              {open === "advanced" && (
                <PromptPopover onClick={stop} className="w-[calc(100vw-2rem)] md:w-[320px]">
                  <PromptPopoverHeader>Advanced</PromptPopoverHeader>
                  <div className="flex flex-col gap-3 px-1">
                    {kind === "video" && (
                      <>
                        <Field label="Mode">
                          <div className="flex gap-2 normal-case tracking-normal">
                            {[[true, "Fast (4-step LoRA)"], [false, "Quality (18 steps)"]].map(([v, label]) => (
                              <button key={String(v)} type="button" onClick={() => setAdvanced((a) => ({ ...a, fast: v }))} className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold border ${advanced.fast === v ? "border-[#22d3ee]/50 text-[#22d3ee] bg-[#22d3ee]/10" : "border-white/10 text-white/50"}`}>{label}</button>
                            ))}
                          </div>
                        </Field>
                        <Field label="Frames">
                          <div className="flex gap-2 normal-case tracking-normal">
                            {FRAME_CHOICES.map((f) => (
                              <button key={f} type="button" onClick={() => setAdvanced((a) => ({ ...a, frames: f }))} className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold border ${advanced.frames === f ? "border-[#22d3ee]/50 text-[#22d3ee] bg-[#22d3ee]/10" : "border-white/10 text-white/50"}`}>{f} · {(f / 16).toFixed(1)}s</button>
                            ))}
                          </div>
                        </Field>
                      </>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Steps"><input className={inputClass} inputMode="numeric" placeholder="default" value={advanced.steps} onChange={(e) => setAdvanced((a) => ({ ...a, steps: e.target.value }))} /></Field>
                      <Field label="Guidance"><input className={inputClass} inputMode="decimal" placeholder="default" value={advanced.guidance} onChange={(e) => setAdvanced((a) => ({ ...a, guidance: e.target.value }))} /></Field>
                    </div>
                    <Field label="Seed"><input className={inputClass} inputMode="numeric" placeholder="random" value={advanced.seed} onChange={(e) => setAdvanced((a) => ({ ...a, seed: e.target.value }))} /></Field>
                    <Field label="Negative prompt"><textarea className={`${inputClass} resize-none`} rows={2} placeholder="what to avoid" value={negative} onChange={(e) => setNegative(e.target.value)} /></Field>
                  </div>
                </PromptPopover>
              )}
            </div>
          </PromptControls>

          {busy ? (
            <PromptAction onClick={handleCancel} className="!bg-red-400/90 !shadow-red-400/20" data-testid="local-cancel">Cancel</PromptAction>
          ) : (
            <PromptAction onClick={handleGenerate} disabled={!model || status.phase !== "online"} data-testid="local-generate">
              <BoltIcon /> Generate
            </PromptAction>
          )}
        </PromptFooter>
      </PromptComposer>

      {viewer && <Viewer entry={viewer} onClose={() => setViewer(null)} onAnimate={animate} />}
      {confirm && <ConfirmV100 onCancel={() => setConfirm(null)} onConfirm={() => { v100Confirmed.current = true; setConfirm(null); go(); }} />}
    </div>
  );
}
