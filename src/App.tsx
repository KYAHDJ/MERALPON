import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { recognize } from "tesseract.js";

type Reading = { id: string; date: string; time: string; reading: number; notes: string };
type ReadingWithUsage = Reading & { usage: number; cost: number };

const RATE = 14.9061;
const BASELINE = 8869;
const GOAL = 250;
const STORAGE_KEY = "meralco-kwh-readings-v1";
const seed: Reading[] = [
  { id: "baseline", date: "2026-09-29", time: "08:00", reading: BASELINE, notes: "Cycle baseline" },
  { id: "sample", date: "2026-10-04", time: "08:15", reading: 8885, notes: "Latest meter check" },
];

const money = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const number = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const timeNow = () => new Date().toTimeString().slice(0, 5);

function Icon({ name, className = "" }: { name: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    bolt: <path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z" />,
    upload: <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/></>,
    camera: <><path d="M4 7h3l1.4-2h7.2L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></>,
    edit: <><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m14 7 3 3"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7"/><path d="M10 11v5m4-5v5"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    trend: <><path d="m4 16 5-5 4 4 7-8"/><path d="M15 7h5v5"/></>,
    chart: <path d="M5 19V13m5 6V9m5 10v-4m5 4V5"/>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-head"><div><p className="kicker">Meter log</p><h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
      {children}
    </section>
  </div>;
}

export default function App() {
  const [readings, setReadings] = useState<Reading[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || seed; } catch { return seed; }
  });
  const [modal, setModal] = useState<"add" | "edit" | "ocr" | null>(null);
  const [editing, setEditing] = useState<Reading | null>(null);
  const [form, setForm] = useState({ date: todayISO(), time: timeNow(), reading: "", notes: "" });
  const [dragging, setDragging] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [preview, setPreview] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(readings)), [readings]);
  const computed = useMemo<ReadingWithUsage[]>(() => {
    const sorted = [...readings].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    return sorted.map((item, index) => ({ ...item, usage: index ? Math.max(0, item.reading - sorted[index - 1].reading) : 0, cost: index ? Math.max(0, item.reading - sorted[index - 1].reading) * RATE : 0 }));
  }, [readings]);
  const latest = computed.at(-1) || { ...seed[0], usage: 0, cost: 0 };
  const previous = computed.at(-2);
  const cycleUsage = Math.max(0, latest.reading - BASELINE);
  const cycleCost = cycleUsage * RATE;
  const recent = computed.filter((r) => r.usage > 0).slice(-7);
  const rollingAverage = recent.length ? recent.reduce((sum, r) => sum + r.usage, 0) / recent.length : 0;
  const latestDate = new Date(`${latest.date}T12:00:00`);
  const daysInMonth = new Date(latestDate.getFullYear(), latestDate.getMonth() + 1, 0).getDate();
  const remainingDays = Math.max(0, daysInMonth - latestDate.getDate());
  const projectedCost = (cycleUsage + rollingAverage * remainingDays) * RATE;
  const change = previous?.usage ? ((latest.usage - previous.usage) / previous.usage) * 100 : 0;
  const progress = Math.min(100, (cycleUsage / GOAL) * 100);

  const openAdd = (reading = "") => { setEditing(null); setForm({ date: todayISO(), time: timeNow(), reading, notes: "" }); setModal("add"); };
  const openEdit = (item: Reading) => { setEditing(item); setForm({ date: item.date, time: item.time, reading: String(item.reading), notes: item.notes }); setModal("edit"); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(form.reading);
    if (!Number.isFinite(value) || value < 0) return;
    const item = { id: editing?.id || crypto.randomUUID(), date: form.date, time: form.time, reading: value, notes: form.notes.trim() };
    setReadings((current) => editing ? current.map((r) => r.id === editing.id ? item : r) : [...current, item]);
    setModal(null); setEditing(null);
  };

  const scan = async (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl); setOcrStatus("Preparing image…"); setOcrProgress(0.05); setForm({ date: todayISO(), time: timeNow(), reading: "", notes: "Scanned from meter photo" }); setModal("ocr");
    try {
      const result = await recognize(file, "eng", { logger: (message) => { if (message.status) setOcrStatus(message.status.replace(/\b\w/g, (c) => c.toUpperCase())); if (message.progress) setOcrProgress(message.progress); } });
      const candidates = result.data.text.match(/\d[\d\s,.]{3,8}\d/g)?.map((v) => v.replace(/\D/g, "")).filter((v) => v.length === 5) || [];
      setForm((current) => ({ ...current, reading: candidates[0] || "" }));
      setOcrStatus(candidates[0] ? "Reading found — please verify" : "No clear reading found — enter it below"); setOcrProgress(1);
    } catch { setOcrStatus("Scan could not finish — enter the reading below"); setOcrProgress(1); }
  };
  const exportFile = (kind: "json" | "csv") => {
    const body = kind === "json" ? JSON.stringify(readings, null, 2) : ["Date,Time,Meter Reading,Daily Usage,Daily Cost,Notes", ...computed.map((r) => [r.date, r.time, r.reading, r.usage.toFixed(2), r.cost.toFixed(2), `"${r.notes.replaceAll('"', '""')}"`].join(","))].join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" })); link.download = `meralco-readings.${kind}`; link.click(); URL.revokeObjectURL(link.href);
  };
  const importJSON = async (file?: File) => {
    if (!file) return;
    try { const data = JSON.parse(await file.text()); if (!Array.isArray(data) || !data.every((r) => r.date && r.time && Number.isFinite(Number(r.reading)))) throw new Error(); setReadings(data.map((r) => ({ id: r.id || crypto.randomUUID(), date: r.date, time: r.time, reading: Number(r.reading), notes: String(r.notes || "") }))); }
    catch { alert("That file is not a valid Meralco Tracker JSON export."); }
  };

  return <main className="app-shell"><div className="grid-glow" /><div className="container">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Icon name="bolt" /></span><div><h1>Meralco kWh Tracker</h1><p>Cycle started September 29, 2026</p></div></div><div className="header-actions"><span className="rate-pill"><span /> Rate {money.format(RATE)}/kWh</span><button className="primary small" onClick={() => openAdd()}><Icon name="plus" /> Add reading</button></div></header>
    <section className="dashboard" aria-label="Current cycle summary">
      <article className="metric-card today-card"><div className="metric-icon cyan"><Icon name="chart" /></div><p className="kicker">Today's usage</p><h2>{number.format(latest.usage)} <small>kWh</small></h2><p className="metric-cost">{money.format(latest.cost)}</p><span className={`change ${change <= 0 ? "good" : "warn"}`}>{previous ? `${change > 0 ? "+" : ""}${change.toFixed(0)}% vs previous` : "First reading"}</span></article>
      <article className="gauge-card"><div className="gauge" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><div className="gauge-core"><p>Current reading</p><h2>{latest.reading.toLocaleString("en-PH")} <small>kWh</small></h2><span>{progress.toFixed(0)}% of {GOAL} kWh goal</span></div></div><div className="cycle-stats"><div><span>Cycle consumption</span><strong>{number.format(cycleUsage)} kWh</strong></div><i /><div><span>Running cycle cost</span><strong>{money.format(cycleCost)}</strong></div></div></article>
      <article className="metric-card estimate-card"><div className="metric-icon green"><Icon name="trend" /></div><p className="kicker">Tomorrow est.</p><h2>{number.format(rollingAverage)} <small>kWh</small></h2><p className="metric-cost">{money.format(rollingAverage * RATE)}</p><span className="projection">Month-end est. <b>{money.format(projectedCost)}</b></span></article>
    </section>
    <section className="work-grid"><article className="panel upload-panel"><div className="section-title"><div><p className="kicker">Quick capture</p><h2>Scan your meter</h2></div><span>OCR powered</span></div><input ref={fileRef} hidden type="file" accept="image/*" onChange={(e) => scan(e.target.files?.[0])} /><input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onChange={(e) => scan(e.target.files?.[0])} /><div className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(false); scan(e.dataTransfer.files[0]); }}><span className="camera"><Icon name="camera" /></span><strong>Capture your meter reading</strong><small>Take a new photo or use one from your gallery</small><div className="capture-actions"><button type="button" className="outline-button camera-button" onClick={() => cameraRef.current?.click()}><Icon name="camera" /> Take photo</button><button type="button" className="outline-button" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Choose photo</button></div></div></article>
      <aside className="panel insight-panel"><div className="section-title"><div><p className="kicker">7-day signal</p><h2>Usage outlook</h2></div></div><div className="insight-number"><span>Daily average</span><strong>{number.format(rollingAverage)} kWh</strong></div><div className="mini-bars" aria-hidden="true">{(recent.length ? recent : [{usage:0}]).map((r, i) => <span key={i} style={{ height: `${Math.max(10, Math.min(100, r.usage / Math.max(...recent.map(x => x.usage), 1) * 100))}%` }} />)}</div><p>At this pace, your projected month-end cycle cost is <b>{money.format(projectedCost)}</b>.</p></aside></section>
    <section className="panel ledger"><div className="ledger-head"><div><p className="kicker">Consumption history</p><h2>Meter readings</h2><p>{computed.length} entries saved on this device</p></div><div className="ledger-actions"><button onClick={() => importRef.current?.click()}>Import JSON</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(e) => importJSON(e.target.files?.[0])}/><button onClick={() => exportFile("json")}><Icon name="download" /> JSON</button><button onClick={() => exportFile("csv")}><Icon name="download" /> CSV</button></div></div><div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Meter reading</th><th>Daily usage</th><th>Daily cost</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{[...computed].reverse().map((r) => <tr key={r.id}><td><strong>{new Date(`${r.date}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</strong><span>{r.time}</span></td><td>{r.reading.toLocaleString("en-PH")} <small>kWh</small></td><td className="usage">{r.id === computed[0]?.id ? "—" : `+${number.format(r.usage)} kWh`}</td><td>{r.id === computed[0]?.id ? "—" : money.format(r.cost)}</td><td className="notes">{r.notes || "—"}</td><td><div className="row-actions"><button onClick={() => openEdit(r)} aria-label="Edit reading"><Icon name="edit" /></button><button disabled={readings.length === 1} onClick={() => confirm("Delete this reading?") && setReadings((list) => list.filter((x) => x.id !== r.id))} aria-label="Delete reading"><Icon name="trash" /></button></div></td></tr>)}</tbody></table></div></section>
    <footer>Calculated at {money.format(RATE)} per kWh · Data stays in your browser</footer>
  </div>
  {(modal === "add" || modal === "edit") && <Modal title={modal === "edit" ? "Edit reading" : "Add a reading"} onClose={() => setModal(null)}><ReadingForm form={form} setForm={setForm} submit={submit} label={modal === "edit" ? "Save changes" : "Add to log"} /></Modal>}
  {modal === "ocr" && <Modal title="Verify scanned reading" onClose={() => setModal(null)}><div className="scan-preview">{preview && <img src={preview} alt="Uploaded meter" />}<div className="scan-status"><span style={{ width: `${ocrProgress * 100}%` }} /></div><p>{ocrStatus}</p></div><ReadingForm form={form} setForm={setForm} submit={submit} label="Confirm & save" /></Modal>}
  </main>;
}

function ReadingForm({ form, setForm, submit, label }: { form: { date: string; time: string; reading: string; notes: string }; setForm: React.Dispatch<React.SetStateAction<{ date: string; time: string; reading: string; notes: string }>>; submit: (e: FormEvent) => void; label: string }) {
  return <form onSubmit={submit} className="reading-form"><div className="field featured"><label htmlFor="reading">Meter reading</label><div><input id="reading" autoFocus required inputMode="numeric" pattern="[0-9]*" value={form.reading} onChange={(e) => setForm((f) => ({ ...f, reading: e.target.value.replace(/\D/g, "").slice(0, 8) }))} placeholder="00000"/><span>kWh</span></div></div><div className="field-row"><div className="field"><label htmlFor="date">Date</label><input id="date" type="date" required value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}/></div><div className="field"><label htmlFor="time">Time</label><input id="time" type="time" required value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}/></div></div><div className="field"><label htmlFor="notes">Notes <span>optional</span></label><input id="notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Aircon used overnight"/></div><button className="primary modal-submit" type="submit">{label}</button></form>;
}
