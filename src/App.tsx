import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { recognize } from "tesseract.js";
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

type Reading = { id: string; date: string; time: string; reading: number; notes: string };
type ReadingWithUsage = Reading & { usage: number; cost: number };

const RATE = 14.9061;
const GOAL = 250;
const STORAGE_KEY = "meralco-kwh-readings-v1";
const PERIOD_KEY = "meralco-kwh-billing-period-v1";
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
  const [periodForm, setPeriodForm] = useState(period);
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
  const [authReady, setAuthReady] = useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const [syncState, setSyncState] = useState<"connecting" | "synced" | "offline" | "error">("connecting");
  const lastSyncedPayload = useRef("");

  useEffect(() => onAuthStateChanged(auth, (nextUser) => {
    setUser(nextUser);
    setAuthReady(true);
    setCloudReady(false);
    setSyncState(nextUser ? "connecting" : "offline");
  }), []);

  useEffect(() => {
    if (!user) return;
    const stateRef = doc(db, "users", user.uid, "tracker", "state");
    let unsubscribe = () => {};
    getDoc(stateRef).then(async (snapshot) => {
      if (!snapshot.exists()) {
        await setDoc(stateRef, { readings, period, periodConfigured, updatedAt: Date.now() });
      }
      unsubscribe = onSnapshot(stateRef, { includeMetadataChanges: true }, (cloudSnapshot) => {
        const data = cloudSnapshot.data();
        if (data?.readings && Array.isArray(data.readings)) setReadings(data.readings as Reading[]);
        if (data?.period?.start && data?.period?.end) {
          setPeriod(data.period);
          setPeriodForm(data.period);
          setPeriodConfigured(data.periodConfigured !== false);
        }
        lastSyncedPayload.current = JSON.stringify({
          readings: data?.readings || readings,
          period: data?.period || period,
          periodConfigured: data?.periodConfigured ?? periodConfigured,
        });
        setCloudReady(true);
        setSyncState(cloudSnapshot.metadata.hasPendingWrites ? "connecting" : "synced");
      }, () => setSyncState("error"));
    }).catch(() => setSyncState("error"));
    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user || !cloudReady) return;
    const payload = { readings, period, periodConfigured };
    const serialized = JSON.stringify(payload);
    if (serialized === lastSyncedPayload.current) return;
    lastSyncedPayload.current = serialized;
    setSyncState("connecting");
    setDoc(doc(db, "users", user.uid, "tracker", "state"), { ...payload, updatedAt: Date.now() })
      .then(() => setSyncState("synced"))
      .catch(() => setSyncState("error"));
  }, [readings, period, periodConfigured, user, cloudReady]);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(readings)), [readings]);
  useEffect(() => { if (periodConfigured) localStorage.setItem(PERIOD_KEY, JSON.stringify(period)); }, [period, periodConfigured]);
  const computed = useMemo<ReadingWithUsage[]>(() => {
    const sorted = readings.filter((item) => item.date >= period.start && item.date <= period.end).sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    return sorted.map((item, index) => ({ ...item, usage: index ? Math.max(0, item.reading - sorted[index - 1].reading) : 0, cost: index ? Math.max(0, item.reading - sorted[index - 1].reading) * RATE : 0 }));
  }, [readings, period]);
  const latest = computed.at(-1) || { ...seed[0], usage: 0, cost: 0 };
  const previous = computed.at(-2);
  const baselineReading = computed[0]?.reading ?? latest.reading;
  const cycleUsage = Math.max(0, latest.reading - baselineReading);
  const cycleCost = cycleUsage * RATE;
  const recent = computed.filter((r) => r.usage > 0).slice(-7);
  const rollingAverage = recent.length ? recent.reduce((sum, r) => sum + r.usage, 0) / recent.length : 0;
  const latestDate = new Date(`${latest.date}T12:00:00`);
  const periodEndDate = new Date(`${period.end}T12:00:00`);
  const remainingDays = Math.max(0, Math.ceil((periodEndDate.getTime() - latestDate.getTime()) / 86400000));
  const projectedCost = (cycleUsage + rollingAverage * remainingDays) * RATE;
  const change = previous?.usage ? ((latest.usage - previous.usage) / previous.usage) * 100 : 0;
  const progress = Math.min(100, (cycleUsage / GOAL) * 100);
  const periodExpired = todayISO() > period.end;
  const periodLabel = `${new Date(`${period.start}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${new Date(`${period.end}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}`;

  const openPeriod = () => { setPeriodForm(period); setModal("period"); };
  const savePeriod = (event: FormEvent) => {
    event.preventDefault();
    if (!periodForm.start || !periodForm.end || periodForm.end < periodForm.start) return;
    setPeriod(periodForm); setPeriodConfigured(true); setModal(null);
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

  if (!authReady) return <main className="app-shell auth-shell"><div className="auth-card"><span className="brand-mark"><Icon name="bolt" /></span><h1>Meralco kWh Tracker</h1><p>Connecting securely…</p></div></main>;
  if (!user) return <AuthScreen />;

  return <main className="app-shell"><div className="grid-glow" /><div className="container">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Icon name="bolt" /></span><div><h1>Meralco kWh Tracker</h1><button className="period-link" onClick={openPeriod}>Billing period: {periodLabel}</button></div></div><div className="header-actions"><span className={`sync-pill ${syncState}`}><span /> {syncState === "synced" ? "Synced" : syncState === "error" ? "Sync error" : "Syncing…"}</span><span className="rate-pill"><span /> Rate {money.format(RATE)}/kWh</span><button className="account-button" onClick={() => signOut(auth)} title={user.email || "Signed in"}>Sign out</button><button className="primary small" onClick={() => openAdd()}><Icon name="plus" /> Add reading</button></div></header>
    <section className="dashboard" aria-label="Current cycle summary">
      <article className="metric-card today-card"><div className="metric-icon cyan"><Icon name="chart" /></div><p className="kicker">Today's usage</p><h2>{number.format(latest.usage)} <small>kWh</small></h2><p className="metric-cost">{money.format(latest.cost)}</p><span className={`change ${change <= 0 ? "good" : "warn"}`}>{previous ? `${change > 0 ? "+" : ""}${change.toFixed(0)}% vs previous` : "First reading"}</span></article>
      <article className="gauge-card"><div className="gauge" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><div className="gauge-core"><p>Current reading</p><h2>{latest.reading.toLocaleString("en-PH")} <small>kWh</small></h2><span>{progress.toFixed(0)}% of {GOAL} kWh goal</span></div></div><div className="cycle-stats"><div><span>Cycle consumption</span><strong>{number.format(cycleUsage)} kWh</strong></div><i /><div><span>Running cycle cost</span><strong>{money.format(cycleCost)}</strong></div></div></article>
      <article className="metric-card estimate-card"><div className="metric-icon green"><Icon name="trend" /></div><p className="kicker">Tomorrow est.</p><h2>{number.format(rollingAverage)} <small>kWh</small></h2><p className="metric-cost">{money.format(rollingAverage * RATE)}</p><span className="projection">Period-end est. <b>{money.format(projectedCost)}</b></span></article>
    </section>
    <section className="work-grid"><article className="panel upload-panel"><div className="section-title"><div><p className="kicker">Quick capture</p><h2>Scan your meter</h2></div><span>OCR powered</span></div><input ref={fileRef} hidden type="file" accept="image/*" onChange={(e) => scan(e.target.files?.[0])} /><input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onChange={(e) => scan(e.target.files?.[0])} /><div className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(false); scan(e.dataTransfer.files[0]); }}><span className="camera"><Icon name="camera" /></span><strong>Capture your meter reading</strong><small>Take a new photo or use one from your gallery</small><div className="capture-actions"><button type="button" className="outline-button camera-button" onClick={() => cameraRef.current?.click()}><Icon name="camera" /> Take photo</button><button type="button" className="outline-button" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Choose photo</button></div></div></article>
      <aside className="panel insight-panel"><div className="section-title"><div><p className="kicker">7-day signal</p><h2>Usage outlook</h2></div></div><div className="insight-number"><span>Daily average</span><strong>{number.format(rollingAverage)} kWh</strong></div><div className="mini-bars" aria-hidden="true">{(recent.length ? recent : [{usage:0}]).map((r, i) => <span key={i} style={{ height: `${Math.max(10, Math.min(100, r.usage / Math.max(...recent.map(x => x.usage), 1) * 100))}%` }} />)}</div><p>At this pace, your projected billing-period cost is <b>{money.format(projectedCost)}</b>.</p></aside></section>
    <section className="panel ledger"><div className="ledger-head"><div><p className="kicker">Consumption history</p><h2>Meter readings</h2><p>{computed.length} entries synced to your account</p></div><div className="ledger-actions"><button onClick={() => importRef.current?.click()}>Import JSON</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(e) => importJSON(e.target.files?.[0])}/><button onClick={() => exportFile("json")}><Icon name="download" /> JSON</button><button onClick={() => exportFile("csv")}><Icon name="download" /> CSV</button></div></div><div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Meter reading</th><th>Daily usage</th><th>Daily cost</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{[...computed].reverse().map((r) => <tr key={r.id}><td><strong>{new Date(`${r.date}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</strong><span>{r.time}</span></td><td>{r.reading.toLocaleString("en-PH")} <small>kWh</small></td><td className="usage">{r.id === computed[0]?.id ? "—" : `+${number.format(r.usage)} kWh`}</td><td>{r.id === computed[0]?.id ? "—" : money.format(r.cost)}</td><td className="notes">{r.notes || "—"}</td><td><div className="row-actions"><button onClick={() => openEdit(r)} aria-label="Edit reading"><Icon name="edit" /></button><button disabled={readings.length === 1} onClick={() => confirm("Delete this reading?") && setReadings((list) => list.filter((x) => x.id !== r.id))} aria-label="Delete reading"><Icon name="trash" /></button></div></td></tr>)}</tbody></table></div></section>
    <footer>Calculated at {money.format(RATE)} per kWh · Synced securely with Firebase</footer>
  </div>
  {(modal === "add" || modal === "edit") && <Modal title={modal === "edit" ? "Edit reading" : "Add a reading"} onClose={() => setModal(null)}><ReadingForm form={form} setForm={setForm} submit={submit} label={modal === "edit" ? "Save changes" : "Add to log"} /></Modal>}
  {modal === "ocr" && <Modal title="Verify scanned reading" onClose={() => setModal(null)}><div className="scan-preview">{preview && <img src={preview} alt="Uploaded meter" />}<div className="scan-status"><span style={{ width: `${ocrProgress * 100}%` }} /></div><p>{ocrStatus}</p></div><ReadingForm form={form} setForm={setForm} submit={submit} label="Confirm & save" /></Modal>}
  {modal === "period" && <Modal title={periodExpired ? "Start a new billing period" : periodConfigured ? "Edit billing period" : "Set your billing period"} onClose={() => periodConfigured && !periodExpired && setModal(null)}><form className="reading-form" onSubmit={savePeriod}><p className="period-help">Both dates are required. This form will stay out of the way during an active billing period and return only after its end date.</p><div className="field-row"><div className="field"><label htmlFor="period-start">Start date</label><input id="period-start" type="date" required value={periodForm.start} onChange={(e) => setPeriodForm((value: typeof DEFAULT_PERIOD) => ({ ...value, start: e.target.value }))}/></div><div className="field"><label htmlFor="period-end">End date</label><input id="period-end" type="date" required min={periodForm.start} value={periodForm.end} onChange={(e) => setPeriodForm((value: typeof DEFAULT_PERIOD) => ({ ...value, end: e.target.value }))}/></div></div><button className="primary modal-submit" type="submit">Save billing period</button></form></Modal>}
  </main>;
}

function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const authenticate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
    } catch (reason) {
      const code = (reason as { code?: string }).code || "";
      setError(code.includes("invalid-credential") ? "Incorrect email or password." : code.includes("email-already-in-use") ? "That email already has an account. Sign in instead." : code.includes("weak-password") ? "Use a password with at least 6 characters." : "Could not continue. Check Firebase setup and try again.");
    } finally { setBusy(false); }
  };

  return <main className="app-shell auth-shell"><div className="grid-glow" /><section className="auth-card"><span className="brand-mark"><Icon name="bolt" /></span><p className="kicker">Private cloud sync</p><h1>Meralco kWh Tracker</h1><p>Use the same account on every device to keep readings synchronized.</p><form className="reading-form auth-form" onSubmit={authenticate}><div className="field"><label htmlFor="auth-email">Email</label><input id="auth-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></div><div className="field"><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></div>{error && <p className="auth-error">{error}</p>}<button className="primary modal-submit" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</button></form><button className="auth-switch" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }}>{mode === "signin" ? "First time? Create an account" : "Already have an account? Sign in"}</button></section></main>;
}

function ReadingForm({ form, setForm, submit, label }: { form: { date: string; time: string; reading: string; notes: string }; setForm: React.Dispatch<React.SetStateAction<{ date: string; time: string; reading: string; notes: string }>>; submit: (e: FormEvent) => void; label: string }) {
  return <form onSubmit={submit} className="reading-form"><div className="field featured"><label htmlFor="reading">Meter reading</label><div><input id="reading" autoFocus required inputMode="numeric" pattern="[0-9]*" value={form.reading} onChange={(e) => setForm((f) => ({ ...f, reading: e.target.value.replace(/\D/g, "").slice(0, 8) }))} placeholder="00000"/><span>kWh</span></div></div><div className="field-row"><div className="field"><label htmlFor="date">Date</label><input id="date" type="date" required value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}/></div><div className="field"><label htmlFor="time">Time</label><input id="time" type="time" required value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}/></div></div><div className="field"><label htmlFor="notes">Notes <span>optional</span></label><input id="notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Aircon used overnight"/></div><button className="primary modal-submit" type="submit">{label}</button></form>;
}
