import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { createWorker, PSM } from "tesseract.js";
import { createUserWithEmailAndPassword, onAuthStateChanged, reload, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

type Reading = { id: string; date: string; time: string; reading: number; notes: string };
type ReadingWithUsage = Reading & { usage: number; cost: number };

const DEFAULT_RATE = 14.9061;
const STORAGE_KEY = "meralco-kwh-readings-v1";
const PERIOD_KEY = "meralco-kwh-billing-period-v1";
const RATE_KEY = "meralco-kwh-rate-v1";
const DEFAULT_PERIOD = { start: "2026-09-29", end: "2026-10-28" };
const seed: Reading[] = [
  { id: "baseline", date: "2026-09-29", time: "16:10", reading: 8869, notes: "Baseline (bill cut-off)" },
  { id: "sep30", date: "2026-09-30", time: "18:11", reading: 8873, notes: "Meter photo" },
  { id: "oct01", date: "2026-10-01", time: "22:44", reading: 8877, notes: "Meter photo" },
  { id: "oct02", date: "2026-10-02", time: "16:04", reading: 8878, notes: "Meter photo" },
  { id: "oct03", date: "2026-10-03", time: "16:32", reading: 8882, notes: "Meter photo" },
  { id: "oct04", date: "2026-10-04", time: "16:09", reading: 8885, notes: "Meter photo" },
  { id: "oct05", date: "2026-10-05", time: "22:20", reading: 8888, notes: "Meter photo" },
];

const money = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const number = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 });
const wholeNumber = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const timeNow = () => new Date().toTimeString().slice(0, 5);

async function prepareMeterImage(file: File) {
  const image = await createImageBitmap(file);
  const scale = Math.max(1, Math.min(2.5, 1800 / image.width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return file;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const gray = pixels.data[index] * .3 + pixels.data[index + 1] * .59 + pixels.data[index + 2] * .11;
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.7 + 128));
    pixels.data[index] = contrasted;
    pixels.data[index + 1] = contrasted;
    pixels.data[index + 2] = contrasted;
  }
  context.putImageData(pixels, 0, 0);
  return await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", .94));
}

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
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Reading[] | null;
      if (!saved || (saved.length === 2 && saved.some((item) => item.id === "sample"))) return seed;
      return saved;
    } catch { return seed; }
  });
  const [periodConfigured, setPeriodConfigured] = useState(() => Boolean(localStorage.getItem(PERIOD_KEY)));
  const [period, setPeriod] = useState(() => {
    try { return JSON.parse(localStorage.getItem(PERIOD_KEY) || "null") || DEFAULT_PERIOD; } catch { return DEFAULT_PERIOD; }
  });
  const [rate, setRate] = useState(() => {
    const saved = Number(localStorage.getItem(RATE_KEY));
    return saved > 0 ? saved : DEFAULT_RATE;
  });
  const [periodForm, setPeriodForm] = useState(period);
  const [rateForm, setRateForm] = useState(String(rate));
  const [modal, setModal] = useState<"add" | "edit" | "ocr" | "period" | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PERIOD_KEY) || "null");
      return !saved || todayISO() > saved.end ? "period" : null;
    } catch { return "period"; }
  });
  const [editing, setEditing] = useState<Reading | null>(null);
  const [form, setForm] = useState({ date: todayISO(), time: timeNow(), reading: "", notes: "" });
  const [dragging, setDragging] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [preview, setPreview] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [user, setUser] = useState<User | null>(null);
  const [guestMode, setGuestMode] = useState(false);
  const [authVersion, setAuthVersion] = useState(0);
  const [authReady, setAuthReady] = useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const [syncState, setSyncState] = useState<"connecting" | "synced" | "offline" | "error">("connecting");
  const lastSyncedPayload = useRef("");

  useEffect(() => onAuthStateChanged(auth, (nextUser) => {
    setUser(nextUser);
    if (nextUser) setGuestMode(false);
    setAuthReady(true);
    setCloudReady(false);
    setSyncState(nextUser ? "connecting" : "offline");
  }), []);

  useEffect(() => {
    if (!user || !user.emailVerified) return;
    const stateRef = doc(db, "users", user.uid, "tracker", "state");
    let unsubscribe = () => {};
    setReadings([]);
    setPeriod(DEFAULT_PERIOD);
    setRate(DEFAULT_RATE);
    setPeriodConfigured(false);
    getDoc(stateRef).then(async (snapshot) => {
      if (!snapshot.exists()) {
        await setDoc(stateRef, { readings: [], period: DEFAULT_PERIOD, periodConfigured: false, rate: DEFAULT_RATE, updatedAt: Date.now() });
      }
      unsubscribe = onSnapshot(stateRef, { includeMetadataChanges: true }, (cloudSnapshot) => {
        const data = cloudSnapshot.data();
        if (data?.readings && Array.isArray(data.readings)) setReadings(data.readings as Reading[]);
        if (data?.period?.start && data?.period?.end) {
          setPeriod(data.period);
          setPeriodForm(data.period);
          setPeriodConfigured(data.periodConfigured !== false);
          if (data.periodConfigured === false) setModal("period");
        }
        if (Number(data?.rate) > 0) setRate(Number(data.rate));
        lastSyncedPayload.current = JSON.stringify({
          readings: data?.readings || readings,
          period: data?.period || period,
          periodConfigured: data?.periodConfigured ?? periodConfigured,
          rate: Number(data?.rate) > 0 ? Number(data.rate) : rate,
        });
        setCloudReady(true);
        setSyncState(cloudSnapshot.metadata.hasPendingWrites ? "connecting" : "synced");
      }, () => setSyncState("error"));
    }).catch(() => setSyncState("error"));
    return () => unsubscribe();
  }, [user, authVersion]);

  useEffect(() => {
    if (!user || !user.emailVerified || !cloudReady || guestMode) return;
    const payload = { readings, period, periodConfigured, rate };
    const serialized = JSON.stringify(payload);
    if (serialized === lastSyncedPayload.current) return;
    lastSyncedPayload.current = serialized;
    setSyncState("connecting");
    setDoc(doc(db, "users", user.uid, "tracker", "state"), { ...payload, updatedAt: Date.now() })
      .then(() => setSyncState("synced"))
      .catch(() => setSyncState("error"));
  }, [readings, period, periodConfigured, rate, user, cloudReady, guestMode]);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(readings)), [readings]);
  useEffect(() => { if (periodConfigured) localStorage.setItem(PERIOD_KEY, JSON.stringify(period)); }, [period, periodConfigured]);
  useEffect(() => localStorage.setItem(RATE_KEY, String(rate)), [rate]);
  const computed = useMemo<ReadingWithUsage[]>(() => {
    const sorted = readings.filter((item) => item.date >= period.start && item.date <= period.end).sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    return sorted.map((item, index) => ({ ...item, usage: index ? Math.max(0, item.reading - sorted[index - 1].reading) : 0, cost: index ? Math.max(0, item.reading - sorted[index - 1].reading) * rate : 0 }));
  }, [readings, period, rate]);
  const latest = computed.at(-1) || { id: "empty", date: period.start, time: "00:00", reading: 0, notes: "", usage: 0, cost: 0 };
  const previous = computed.at(-2);
  const baselineReading = computed[0]?.reading ?? latest.reading;
  const cycleUsage = Math.max(0, latest.reading - baselineReading);
  const cycleCost = cycleUsage * rate;
  const normalizedDaily = computed.slice(1).map((item, index) => {
    const previousItem = computed[index];
    const hours = (new Date(`${item.date}T${item.time}`).getTime() - new Date(`${previousItem.date}T${previousItem.time}`).getTime()) / 3600000;
    return { ...item, dailyRate: hours > 4 ? item.usage / hours * 24 : item.usage };
  }).filter((item) => item.dailyRate > 0).slice(-10);
  const rollingAverage = normalizedDaily.length ? normalizedDaily.reduce((sum, item) => sum + item.dailyRate, 0) / normalizedDaily.length : 0;
  const forecastTomorrow = useMemo(() => {
    if (!normalizedDaily.length) return 0;
    const values = normalizedDaily.map((item) => item.dailyRate);
    const weighted = values.reduce((sum, value, index) => sum + value * (index + 1), 0) / values.reduce((sum, _, index) => sum + index + 1, 0);
    const xMean = (values.length - 1) / 2;
    const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const denominator = values.reduce((sum, _, index) => sum + (index - xMean) ** 2, 0);
    const slope = denominator ? values.reduce((sum, value, index) => sum + (index - xMean) * (value - yMean), 0) / denominator : 0;
    const trend = values.at(-1)! + slope;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.max(0, Math.min(median * 1.75, Math.max(median * .5, weighted * .72 + trend * .28)));
  }, [computed]);
  const latestDate = new Date(`${latest.date}T12:00:00`);
  const periodEndDate = new Date(`${period.end}T12:00:00`);
  const remainingDays = Math.max(0, Math.ceil((periodEndDate.getTime() - latestDate.getTime()) / 86400000));
  const projectedUsage = cycleUsage + forecastTomorrow * remainingDays;
  const projectedMeterReading = latest.reading + forecastTomorrow * remainingDays;
  const projectedCost = projectedUsage * rate;
  const change = previous?.usage ? ((latest.usage - previous.usage) / previous.usage) * 100 : 0;
  const periodStartDate = new Date(`${period.start}T12:00:00`);
  const totalPeriodDays = Math.max(1, Math.floor((periodEndDate.getTime() - periodStartDate.getTime()) / 86400000) + 1);
  const elapsedPeriodDays = Math.max(1, Math.floor((latestDate.getTime() - periodStartDate.getTime()) / 86400000) + 1);
  const progress = Math.min(100, elapsedPeriodDays / totalPeriodDays * 100);
  const periodExpired = todayISO() > period.end;
  const periodLabel = `${new Date(`${period.start}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${new Date(`${period.end}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}`;

  const openPeriod = () => { setPeriodForm(period); setRateForm(String(rate)); setModal("period"); };
  const savePeriod = (event: FormEvent) => {
    event.preventDefault();
    const nextRate = Number(rateForm);
    if (!periodForm.start || !periodForm.end || periodForm.end < periodForm.start || !Number.isFinite(nextRate) || nextRate <= 0) return;
    setPeriod(periodForm); setRate(nextRate); setPeriodConfigured(true); setModal(null);
  };
  const resetAccount = () => {
    if (!confirm("Delete every reading and billing setting from this account? This cannot be undone.")) return;
    setReadings([]);
    setPeriod(DEFAULT_PERIOD);
    setPeriodForm(DEFAULT_PERIOD);
    setRate(DEFAULT_RATE);
    setRateForm(String(DEFAULT_RATE));
    setPeriodConfigured(false);
    setModal("period");
  };

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
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      const prepared = await prepareMeterImage(file);
      worker = await createWorker("eng", 1, { logger: (message) => { if (message.status) setOcrStatus(message.status.replace(/\b\w/g, (character) => character.toUpperCase())); if (message.progress) setOcrProgress(message.progress); } });
      await worker.setParameters({ tessedit_char_whitelist: "0123456789", tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      const result = await worker.recognize(prepared);
      const groups = result.data.text.match(/\d+/g) || [];
      const candidates = groups.flatMap((value) => value.length > 5 ? [value.slice(0, 5), value.slice(-5)] : [value]).filter((value) => value.length >= 4 && value.length <= 5);
      const found = candidates.map(Number).filter(Number.isFinite).sort((a, b) => Math.abs(a - latest.reading) - Math.abs(b - latest.reading))[0];
      setForm((current) => ({ ...current, reading: found === undefined ? "" : String(found) }));
      setOcrStatus(found === undefined ? "No clear reading found — enter it below" : "Reading found — check the number before saving"); setOcrProgress(1);
    } catch { setOcrStatus("Scan could not finish — enter the reading below"); setOcrProgress(1); }
    finally { await worker?.terminate(); }
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

  if (!authReady) return <main className="app-shell auth-shell"><div className="auth-card"><span className="brand-mark"><Icon name="bolt" /></span><h1>Meralco kWh Tracker</h1><p>Connecting securely…</p></div></main>;
  if (user && !user.emailVerified) return <VerifyEmailScreen user={user} onVerified={() => setAuthVersion((version) => version + 1)} />;
  if (!user && !guestMode) return <AuthScreen onDemo={() => { setReadings(seed); setPeriod(DEFAULT_PERIOD); setPeriodConfigured(true); setRate(DEFAULT_RATE); setModal(null); setGuestMode(true); setSyncState("offline"); }} />;

  return <main className="app-shell"><div className="grid-glow" /><div className="container">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Icon name="bolt" /></span><div><h1>Meralco kWh Tracker</h1><button className="period-link" onClick={openPeriod}><span>Billing period</span>{periodLabel} <b>Manage</b></button></div></div><div className="header-actions"><span className={`sync-pill ${guestMode ? "demo" : syncState}`}><span /> {guestMode ? "Demo mode" : syncState === "synced" ? "Synced" : syncState === "error" ? "Sync error" : "Syncing…"}</span><button className="rate-pill editable-rate" onClick={openPeriod} title="Edit electricity rate"><span /> {money.format(rate)}/kWh <b>Edit</b></button><button className="account-button" onClick={() => guestMode ? setGuestMode(false) : signOut(auth)} title={guestMode ? "Return to sign in" : user?.email || "Signed in"}>{guestMode ? "Exit demo" : "Sign out"}</button><button className="primary small" onClick={() => openAdd()}><Icon name="plus" /> Add reading</button></div></header>
    <section className="dashboard" aria-label="Current cycle summary">
      <article className="metric-card today-card"><div className="metric-icon cyan"><Icon name="chart" /></div><p className="kicker">Today's usage</p><h2>{wholeNumber.format(latest.usage)} <small>kWh</small></h2><p className="metric-cost">{money.format(latest.cost)}</p><span className={`change ${change <= 0 ? "good" : "warn"}`}>{previous ? `${change > 0 ? "+" : ""}${change.toFixed(0)}% vs previous` : "First reading"}</span></article>
      <article className="gauge-card"><div className="gauge" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><div className="gauge-core"><p>Current reading</p><h2>{latest.reading.toLocaleString("en-PH")} <small>kWh</small></h2><span>Estimated final reading <b>{wholeNumber.format(projectedMeterReading)} kWh</b><em>{money.format(projectedCost)} estimated bill</em></span></div></div><div className="cycle-stats"><div><span>Cycle consumption</span><strong>{wholeNumber.format(cycleUsage)} kWh</strong></div><i /><div><span>Billing day</span><strong>{Math.min(elapsedPeriodDays, totalPeriodDays)} of {totalPeriodDays}</strong></div><i /><div><span>Running cycle cost</span><strong>{money.format(cycleCost)}</strong></div></div></article>
      <article className="metric-card estimate-card"><div className="metric-icon green"><Icon name="trend" /></div><p className="kicker">Tomorrow est.</p><h2>{wholeNumber.format(forecastTomorrow)} <small>kWh</small></h2><p className="metric-cost">{money.format(forecastTomorrow * rate)}</p><span className="projection">Trend-adjusted <b>Recent daily pattern</b></span></article>
    </section>
    <section className="work-grid"><article className="panel upload-panel"><div className="section-title"><div><p className="kicker">Quick capture</p><h2>Scan your meter</h2></div><span>Enhanced OCR</span></div><input ref={fileRef} hidden type="file" accept="image/*" onClick={(event) => { event.currentTarget.value = ""; }} onChange={(e) => scan(e.target.files?.[0])} /><input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onClick={(event) => { event.currentTarget.value = ""; }} onChange={(e) => scan(e.target.files?.[0])} /><div className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(false); scan(e.dataTransfer.files[0]); }}><span className="camera"><Icon name="camera" /></span><strong>Capture your meter reading</strong><small>For best results, fill the frame with the meter digits</small><div className="capture-actions"><button type="button" className="outline-button camera-button" onClick={() => cameraRef.current?.click()}><Icon name="camera" /> Open camera</button><button type="button" className="outline-button" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Choose image</button></div></div></article>
      <aside className="panel insight-panel"><div className="section-title"><div><p className="kicker">Complete billing period</p><h2>Usage outlook</h2></div><span className="scroll-hint">Scroll →</span></div><div className="insight-number"><span>Recent daily average</span><strong>{wholeNumber.format(rollingAverage)} kWh</strong></div><div className="usage-strip">{computed.map((item, index) => <div className="usage-day" key={item.id}><div className="usage-bar"><i style={{ height: `${index === 0 ? 8 : Math.max(12, Math.min(100, item.usage / Math.max(...computed.map((value) => value.usage), 1) * 100))}%` }} /></div><strong>{index === 0 ? "Start" : `${wholeNumber.format(item.usage)} kWh`}</strong><span>{new Date(`${item.date}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}</span><small>{item.time}</small></div>)}</div><p>Every logged date is shown from the billing-period start. Estimated final meter reading: <b>{wholeNumber.format(projectedMeterReading)} kWh</b> with an estimated bill of <b>{money.format(projectedCost)}</b>.</p></aside></section>
    <section className="panel ledger"><div className="ledger-head"><div><p className="kicker">Consumption history</p><h2>Meter readings</h2><p>{computed.length} entries synced to your account</p></div><div className="ledger-actions"><button onClick={() => importRef.current?.click()}>Import JSON</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(e) => importJSON(e.target.files?.[0])}/><button onClick={() => exportFile("json")}><Icon name="download" /> JSON</button><button onClick={() => exportFile("csv")}><Icon name="download" /> CSV</button></div></div><div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Meter reading</th><th>Daily usage</th><th>Daily cost</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{[...computed].reverse().map((r) => <tr key={r.id}><td><strong>{new Date(`${r.date}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</strong><span>{r.time}</span></td><td>{r.reading.toLocaleString("en-PH")} <small>kWh</small></td><td className="usage">{r.id === computed[0]?.id ? "—" : `+${number.format(r.usage)} kWh`}</td><td>{r.id === computed[0]?.id ? "—" : money.format(r.cost)}</td><td className="notes">{r.notes || "—"}</td><td><div className="row-actions"><button onClick={() => openEdit(r)} aria-label="Edit reading"><Icon name="edit" /></button><button disabled={readings.length === 1} onClick={() => confirm("Delete this reading?") && setReadings((list) => list.filter((x) => x.id !== r.id))} aria-label="Delete reading"><Icon name="trash" /></button></div></td></tr>)}</tbody></table></div></section>
    <footer>Calculated at {money.format(rate)} per kWh · Synced securely with Firebase</footer>
  </div>
  {(modal === "add" || modal === "edit") && <Modal title={modal === "edit" ? "Edit reading" : "Add a reading"} onClose={() => setModal(null)}><ReadingForm form={form} setForm={setForm} submit={submit} label={modal === "edit" ? "Save changes" : "Add to log"} /></Modal>}
  {modal === "ocr" && <Modal title="Verify scanned reading" onClose={() => setModal(null)}><div className="scan-preview">{preview && <img src={preview} alt="Uploaded meter" />}<div className="scan-status"><span style={{ width: `${ocrProgress * 100}%` }} /></div><p>{ocrStatus}</p></div><ReadingForm form={form} setForm={setForm} submit={submit} label="Confirm & save" /></Modal>}
  {modal === "period" && <Modal title={periodExpired ? "Start a new billing period" : periodConfigured ? "Billing settings" : "Set your billing period"} onClose={() => periodConfigured && !periodExpired && setModal(null)}><form className="reading-form" onSubmit={savePeriod}><p className="period-help">Set the dates shown on your bill and your current electricity price. Changes sync to every signed-in device.</p><div className="field-row"><div className="field"><label htmlFor="period-start">Billing start</label><input id="period-start" type="date" required value={periodForm.start} onChange={(e) => setPeriodForm((value: typeof DEFAULT_PERIOD) => ({ ...value, start: e.target.value }))}/></div><div className="field"><label htmlFor="period-end">Billing end</label><input id="period-end" type="date" required min={periodForm.start} value={periodForm.end} onChange={(e) => setPeriodForm((value: typeof DEFAULT_PERIOD) => ({ ...value, end: e.target.value }))}/></div></div><div className="field featured rate-field"><label htmlFor="rate">Electricity rate</label><div><span>₱</span><input id="rate" type="number" required min="0.0001" step="0.0001" inputMode="decimal" value={rateForm} onChange={(event) => setRateForm(event.target.value)} /><span>per kWh</span></div></div><button className="primary modal-submit" type="submit">Save billing settings</button>{user && <button className="danger-link" type="button" onClick={resetAccount}>Reset this account and delete all readings</button>}</form></Modal>}
  </main>;
}

function VerifyEmailScreen({ user, onVerified }: { user: User; onVerified: () => void }) {
  const [message, setMessage] = useState("We sent a verification link to your inbox.");
  const [busy, setBusy] = useState(false);

  const checkVerification = async () => {
    setBusy(true);
    try {
      await reload(user);
      if (user.emailVerified) onVerified();
      else setMessage("Not verified yet. Open the link in your email, then check again.");
    } catch { setMessage("Could not check right now. Please try again."); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    setBusy(true);
    try { await sendEmailVerification(user); setMessage("A new verification email was sent. Check your inbox and spam folder."); }
    catch { setMessage("Please wait before requesting another email, then try again."); }
    finally { setBusy(false); }
  };

  return <main className="app-shell auth-shell"><div className="grid-glow" /><section className="auth-card verify-card"><span className="verify-icon">@</span><p className="kicker">One last step</p><h1>Verify your email</h1><p>For your security, the dashboard stays locked until <b>{user.email}</b> is verified.</p><div className="verify-message">{message}</div><button className="primary modal-submit" disabled={busy} onClick={checkVerification}>{busy ? "Checking…" : "I verified my email"}</button><div className="guest-actions"><button type="button" disabled={busy} onClick={resend}>Resend email</button><button type="button" onClick={() => signOut(auth)}>Use another account</button></div></section></main>;
}

function Tutorial({ onClose, onDemo }: { onClose: () => void; onDemo: () => void }) {
  return <div className="modal-backdrop tutorial-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal tutorial-modal" role="dialog" aria-modal="true" aria-labelledby="tutorial-title"><div className="modal-head"><div><p className="kicker">Quick start</p><h2 id="tutorial-title">How the tracker works</h2></div><button className="icon-button" onClick={onClose} aria-label="Close tutorial"><Icon name="close" /></button></div><div className="tutorial-steps"><article><span>1</span><div><h3>Set your billing cycle</h3><p>Enter the start and end dates from your Meralco bill, plus your current peso rate per kWh.</p></div></article><article><span>2</span><div><h3>Add meter readings</h3><p>Type a reading or photograph the meter. Always verify the number before saving.</p></div></article><article><span>3</span><div><h3>Follow the forecast</h3><p>The dashboard calculates daily usage, running cost, tomorrow’s estimate, and the likely final meter reading.</p></div></article><article><span>4</span><div><h3>Stay synchronized</h3><p>Sign into the same verified account on another device and your real readings will appear automatically.</p></div></article></div><button className="primary modal-submit" onClick={onDemo}>Try the demo without an account</button></section></div>;
}

function AuthScreen({ onDemo }: { onDemo: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTutorial, setShowTutorial] = useState(false);

  const authenticate = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "signup" && password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "signup") {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(credential.user);
      } else await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (reason) {
      const code = (reason as { code?: string }).code || "";
      setError(code.includes("invalid-credential") ? "Incorrect email or password." : code.includes("email-already-in-use") ? "That email already has an account. Sign in instead." : code.includes("weak-password") ? "Use a stronger password with at least 6 characters." : code.includes("too-many-requests") ? "Too many attempts. Please wait a moment and try again." : "Could not continue. Check Firebase setup and try again.");
    } finally { setBusy(false); }
  };

  const resetPassword = async () => {
    if (!email.trim()) {
      setError("Enter your email address first, then select Forgot password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setNotice("Password reset email sent. Check your inbox and spam folder.");
    } catch {
      setError("The reset email could not be sent. Check the address and try again.");
    } finally { setBusy(false); }
  };

  const changeMode = (nextMode: "signin" | "signup") => {
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setError("");
    setNotice("");
  };

  return <main className="app-shell auth-shell"><div className="grid-glow" /><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Icon name="bolt" /></span><div><p className="kicker">Private energy dashboard</p><h1>Meralco Tracker</h1></div></div><p className="auth-intro">Your readings, billing period, and estimates—securely synchronized across your devices.</p><div className="auth-tabs" role="tablist" aria-label="Account access"><button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "active" : ""} onClick={() => changeMode("signin")}>Sign in</button><button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} onClick={() => changeMode("signup")}>Register</button></div><form className="reading-form auth-form" onSubmit={authenticate}><div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></div><div className="field"><div className="password-label"><label htmlFor="auth-password">Password</label>{mode === "signin" && <button type="button" onClick={resetPassword}>Forgot password?</button>}</div><div className="password-input"><input id="auth-password" type={showPassword ? "text" : "password"} required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "At least 6 characters" : "Enter your password"}/><button type="button" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></div>{mode === "signup" && <div className="field"><label htmlFor="auth-confirm-password">Confirm password</label><div className="password-input"><input id="auth-confirm-password" type={showPassword ? "text" : "password"} required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter it again"/></div></div>}{error && <p className="auth-error">{error}</p>}{notice && <p className="auth-notice">{notice}</p>}<button className="primary modal-submit auth-submit" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create secure account" : "Sign in to dashboard"}</button></form><div className="guest-actions"><button type="button" onClick={onDemo}>Explore live demo</button><button type="button" onClick={() => setShowTutorial(true)}>How it works</button></div><p className="auth-security">Your password is handled by Firebase Authentication and is never stored inside the tracker.</p></section>{showTutorial && <Tutorial onClose={() => setShowTutorial(false)} onDemo={() => { setShowTutorial(false); onDemo(); }} />}</main>;
}

function ReadingForm({ form, setForm, submit, label }: { form: { date: string; time: string; reading: string; notes: string }; setForm: React.Dispatch<React.SetStateAction<{ date: string; time: string; reading: string; notes: string }>>; submit: (e: FormEvent) => void; label: string }) {
  return <form onSubmit={submit} className="reading-form"><div className="field featured"><label htmlFor="reading">Meter reading</label><div><input id="reading" autoFocus required inputMode="numeric" pattern="[0-9]*" value={form.reading} onChange={(e) => setForm((f) => ({ ...f, reading: e.target.value.replace(/\D/g, "").slice(0, 8) }))} placeholder="00000"/><span>kWh</span></div></div><div className="field-row"><div className="field"><label htmlFor="date">Date</label><input id="date" type="date" required value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}/></div><div className="field"><label htmlFor="time">Time</label><input id="time" type="time" required value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}/></div></div><div className="field"><label htmlFor="notes">Notes <span>optional</span></label><input id="notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Aircon used overnight"/></div><button className="primary modal-submit" type="submit">{label}</button></form>;
}
