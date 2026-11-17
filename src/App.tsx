import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { createUserWithEmailAndPassword, onAuthStateChanged, reload, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import AccountPanel, { Dialog, Legal, GuidedTour } from "./Experience";
import { accountRecordState, createAccountLease } from "./account-policy.mjs";

type Reading = { id: string; date: string; time: string; reading: number; notes: string };
type ReadingWithUsage = Reading & { usage: number; cost: number };

const DEFAULT_RATE = 14.9061;
const DEFAULT_PERIOD = { start: "2026-09-29", end: "2026-10-28" };
const seed: Reading[] = [
  { id: "baseline", date: "2026-09-29", time: "16:10", reading: 8869, notes: "Starting reading" },
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
const todayISO = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
};
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
    check: <path d="m5 12 5 5 9-10"/>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

// Same markup and classes as the boot screen in index.html, so the handoff to React is seamless.
function LoadingScreen({ label }: { label: string }) {
  return <main className="boot-shell" role="status" aria-live="polite"><div className="boot"><span className="boot-mark"><Icon name="bolt" /></span><span>{label}</span><div className="boot-bar"><i /></div></div></main>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <Dialog title={title} onClose={onClose}>{children}</Dialog>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  // Returning users wait for the sign-in check; everyone else sees the sample at once.
  const [ready, setReady] = useState(() => { try { return !localStorage.getItem("meralpon-returning"); } catch { return false; } });
  const [access, setAccess] = useState(false);
  const [profile, setProfile] = useState(false);
  const activeUid = useRef<string | null>(null);
  const [, refresh] = useState(0);
  useEffect(() => onAuthStateChanged(auth, (next) => {
    if (activeUid.current !== (next?.uid || null)) { setProfile(false); setAccess(false); }
    activeUid.current = next?.uid || null;
    try { next ? localStorage.setItem("meralpon-returning", "1") : localStorage.removeItem("meralpon-returning"); } catch { /* storage blocked: fall back to waiting */ }
    setUser(next);
    setReady(true);
    setAccess(false);
  }), []);
  if (!ready) return <LoadingScreen label="Opening Meralpon…" />;
  if (user && !user.emailVerified) return <VerifyEmailScreen user={user} onVerified={() => refresh((value) => value + 1)} />;
  if (!user && access) return <AuthScreen onDemo={() => setAccess(false)} />;
  if (user && profile) return <AccountPanel user={user} onClose={() => setProfile(false)} />;
  return <Tracker onProfile={() => setProfile(true)} key={user?.uid || "public-demo"} user={user} onSignIn={() => setAccess(true)} />;
}

function Tracker({ user, onSignIn, onProfile }: { user: User | null; onSignIn: () => void; onProfile: () => void }) {
  const guestMode = !user;
  const [readings, setReadings] = useState<Reading[]>(() => guestMode ? seed.map((item) => ({ ...item })) : []);
  const [periodConfigured, setPeriodConfigured] = useState(guestMode);
  const [pastPeriods, setPastPeriods] = useState<{ start: string; end: string; rate: number }[]>([]);
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [rate, setRate] = useState(DEFAULT_RATE);
  const [periodForm, setPeriodForm] = useState(period);
  const [rateForm, setRateForm] = useState(String(rate));
  const [modal, setModal] = useState<"add" | "edit" | "ocr" | "period" | null>(null);
  const deletionObserved = useRef(false);
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [editing, setEditing] = useState<Reading | null>(null);
  const [form, setForm] = useState({ date: todayISO(), time: timeNow(), reading: "", notes: "" });
  const [dragging, setDragging] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [preview, setPreview] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [cloudReady, setCloudReady] = useState(guestMode);
  const [oldRecords, setOldRecords] = useState<any>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; detail: string; action: string; run: () => void } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [syncState, setSyncState] = useState<"connecting" | "synced" | "offline" | "error">("connecting");
  const lastSavedPayload = useRef("");

  useEffect(() => {
    if (!user || !user.emailVerified) return;
    const stateRef = doc(db, "users", user.uid, "tracker", "state");
    const lease = createAccountLease(user.uid, () => auth.currentUser?.uid);
    let first = true;
    const unsubscribe = onSnapshot(stateRef, { includeMetadataChanges: true }, (snapshot) => {
      if (!lease.valid()) return;
      if (!snapshot.exists() && snapshot.metadata.fromCache) return;
      const data = snapshot.data();
      if (data?.deleting || deletionObserved.current) { deletionObserved.current = true; setCloudReady(false); return; }
      const ownership = accountRecordState(user.uid, data);
      if (ownership === "blocked") { setSyncState("error"); setCloudReady(false); return; }
      if (ownership === "review") { setOldRecords(data); setCloudReady(false); return; }
      setOldRecords(null);
      const payload = {
        readings: Array.isArray(data?.readings) ? data.readings as Reading[] : [],
        period: data?.period?.start && data?.period?.end ? data.period : DEFAULT_PERIOD,
        periodConfigured: data?.periodConfigured === true,
        pastPeriods: Array.isArray(data?.pastPeriods) ? (data.pastPeriods as { start: string; end: string; rate: number }[]).filter((p) => p?.start && p?.end && Number(p.rate) > 0) : [],
        rate: Number(data?.rate) > 0 ? Number(data?.rate) : DEFAULT_RATE,
      };
      lastSavedPayload.current = JSON.stringify(payload);
      setReadings(payload.readings);
      setPeriod(payload.period);
      setPeriodConfigured(payload.periodConfigured);
      setPastPeriods(payload.pastPeriods);
      setRate(payload.rate);
      if (first) {
        setPeriodForm(payload.period);
        setRateForm(String(payload.rate));
        first = false;
      }
      setCloudReady(true);
      setSyncState(snapshot.metadata.hasPendingWrites ? "connecting" : snapshot.metadata.fromCache ? "offline" : "synced");
    }, () => { if (lease.valid()) setSyncState("error"); });
    return () => { lease.close(); unsubscribe(); };
  }, [user]);

  useEffect(() => {
    if (deletionObserved.current || !user || !user.emailVerified || !cloudReady || guestMode || auth.currentUser?.uid !== user.uid) return;
    const payload = { readings, period, periodConfigured, rate, pastPeriods };
    const serialized = JSON.stringify(payload);
    if (serialized === lastSavedPayload.current) return;
    lastSavedPayload.current = serialized;
    setSyncState("connecting");
    setDoc(doc(db, "users", user.uid, "tracker", "state"), { ...payload, ownerUid: user.uid, updatedAt: Date.now() })
      .then(() => setSyncState("synced"))
      .catch(() => setSyncState("error"));
  }, [readings, period, periodConfigured, rate, pastPeriods, user, cloudReady, guestMode]);

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
  const lastDaily = normalizedDaily.at(-1);
  const priorDaily = normalizedDaily.slice(0, -1);
  const priorAverage = priorDaily.length ? priorDaily.reduce((sum, item) => sum + item.dailyRate, 0) / priorDaily.length : 0;
  const spike = lastDaily && lastDaily.id === computed.at(-1)?.id && priorDaily.length >= 2 && lastDaily.dailyRate >= priorAverage * 1.5 && lastDaily.dailyRate - priorAverage >= 1 ? { now: lastDaily.dailyRate, average: priorAverage } : null;
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
  const history = pastPeriods.map((p) => {
    const rows = readings.filter((r) => r.date >= p.start && r.date <= p.end).sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    const used = rows.length > 1 ? Math.max(0, rows[rows.length - 1].reading - rows[0].reading) : 0;
    return { ...p, used, cost: used * p.rate };
  }).sort((a, b) => b.start.localeCompare(a.start));
  const selected = computed.find((item) => item.id === picked) || computed.at(-1);
  const periodExpired = todayISO() > period.end;
  const onboarding = !guestMode && (!periodConfigured || !readings.length);
  const step1done = periodConfigured && !periodExpired;
  const periodLabel = `${new Date(`${period.start}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${new Date(`${period.end}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}`;

  const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  const openPeriod = () => { setPeriodForm(period); setRateForm(String(rate)); setModal("period"); };
  const savePeriod = (event: FormEvent) => {
    event.preventDefault();
    const nextRate = Number(rateForm);
    if (!periodForm.start || !periodForm.end || periodForm.end < periodForm.start || !Number.isFinite(nextRate) || nextRate <= 0) return;
    if (periodConfigured && (periodForm.start !== period.start || periodForm.end !== period.end) && readings.some((r) => r.date >= period.start && r.date <= period.end)) {
      setPastPeriods((list) => [{ start: period.start, end: period.end, rate }, ...list.filter((p) => p.start !== period.start)]);
    }
    setPeriod(periodForm); setRate(nextRate); setPeriodConfigured(true); setModal(null);
  };
  const askResetAccount = () => {
    setModal(null);
    setConfirmation({ title: "Reset this account?", detail: "Every reading and billing setting in this account will be deleted. This cannot be undone.", action: "Delete everything", run: resetAccount });
  };
  const resetAccount = () => {
    setReadings([]);
    setPeriod(DEFAULT_PERIOD);
    setPeriodForm(DEFAULT_PERIOD);
    setRate(DEFAULT_RATE);
    setRateForm(String(DEFAULT_RATE));
    setPastPeriods([]);
    setPeriodConfigured(false);
    setModal("period");
  };

  const openAdd = (reading = "") => {
    if (!periodConfigured) { openPeriod(); return; }
    setEditing(null); setFormError("");
    setForm({ date: readings.length ? todayISO() : period.start, time: timeNow(), reading, notes: readings.length ? "" : "Starting reading" });
    setModal("add");
  };
  const openEdit = (item: Reading) => { setEditing(item); setFormError(""); setForm({ date: item.date, time: item.time, reading: String(item.reading), notes: item.notes }); setModal("edit"); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(form.reading);
    setFormError("");
    if (!Number.isFinite(value) || value < 0) return;
    if (form.date < period.start || form.date > period.end) {
      setFormError("Choose a date inside your bill dates, or change your bill dates first.");
      return;
    }
    const others = readings.filter((entry) => entry.id !== editing?.id).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const stamp = form.date + form.time;
    const before = others.filter((entry) => entry.date + entry.time < stamp).at(-1);
    const after = others.find((entry) => entry.date + entry.time > stamp);
    if ((before && value < before.reading) || (after && value > after.reading)) {
      setFormError("This number does not fit between your earlier and later readings. Please check the meter number or date.");
      return;
    }
    const item = { id: editing?.id || crypto.randomUUID(), date: form.date, time: form.time, reading: value, notes: form.notes.trim() };
    setReadings((current) => editing ? current.map((r) => r.id === editing.id ? item : r) : [...current, item]);
    setModal(null); setEditing(null);
  };

  const scan = async (file?: File) => {
    if (!periodConfigured) { openPeriod(); return; }
    if (!file || !file.type.startsWith("image/")) return;
    setEditing(null); setFormError("");
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl); setOcrStatus("Preparing image…"); setOcrProgress(0.05); setForm({ date: todayISO(), time: timeNow(), reading: "", notes: "Scanned from meter photo" }); setModal("ocr");
    let worker: Awaited<ReturnType<typeof import("tesseract.js").createWorker>> | null = null;
    try {
      // Loaded on demand so the photo reader never slows the first page load.
      const { createWorker, PSM } = await import("tesseract.js");
      const prepared = await prepareMeterImage(file);
      worker = await createWorker("eng", 1, { logger: (message) => { if (message.status) setOcrStatus(message.status === "recognizing text" ? "Reading the numbers…" : "Getting the photo reader ready…"); if (message.progress) setOcrProgress(message.progress); } });
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
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" })); link.download = `meralpon-readings.${kind}`; link.click(); URL.revokeObjectURL(link.href);
  };
  const importJSON = async (file?: File) => {
    if (!file) return;
    try { const data = JSON.parse(await file.text()); if (!Array.isArray(data) || !data.every((r) => r.date && r.time && Number.isFinite(Number(r.reading)))) throw new Error(); setReadings(data.map((r) => ({ id: r.id || crypto.randomUUID(), date: r.date, time: r.time, reading: Number(r.reading), notes: String(r.notes || "") }))); }
    catch { setNotice("We couldn’t read that backup. Choose a file saved with the Save backup button."); }
  };

  const reviewOldRecords = async (keep: boolean) => {
    if (!user || auth.currentUser?.uid !== user.uid) return;
    setReviewBusy(true);
    try {
      const target = doc(db, "users", user.uid, "tracker", "state");
      if (!keep) {
        // Retain a private recovery copy before replacing previously mixed records.
        await setDoc(doc(db, "users", user.uid, "recovery", "before-account-fix"), oldRecords);
      }
      await setDoc(target, keep
        ? { ...oldRecords, ownerUid: user.uid, updatedAt: Date.now() }
        : { readings: [], period: DEFAULT_PERIOD, periodConfigured: false, rate: DEFAULT_RATE, ownerUid: user.uid, updatedAt: Date.now() });
    } catch { setSyncState("error"); }
    finally { setReviewBusy(false); }
  };
  if (oldRecords) return <main className="app-shell auth-shell"><section className="auth-card"><h1>Let’s keep your readings separate.</h1><p>You’re signed in as <strong>{user?.email}</strong>.</p><p>An earlier version may have copied readings between accounts on this device. Choose whether the old readings belong here.</p><p>{oldRecords.readings?.length || 0} readings found. Starting fresh keeps a private recovery copy.</p>{syncState === "error" && <p role="alert">We couldn’t save your choice. Please try again.</p>}<button className="primary modal-submit" disabled={reviewBusy} onClick={() => reviewOldRecords(false)}>Start this account fresh</button><button className="account-button modal-submit" disabled={reviewBusy} onClick={() => reviewOldRecords(true)}>These readings are mine — keep them</button><button className="account-button modal-submit" onClick={() => signOut(auth)}>Sign out</button></section></main>;
  if (deletionObserved.current) return <main className="app-shell auth-shell"><section className="auth-card"><h1>Account deletion in progress</h1><p>Finish deleting your account on the device where you started. Saving is paused here.</p><button className="primary" onClick={onProfile}>Continue account deletion</button></section></main>;
  if (!cloudReady && syncState !== "error") return <LoadingScreen label="Opening your readings…" />;
  if (!cloudReady) return <main className="app-shell auth-shell"><section className="auth-card"><h1>We couldn’t open your readings</h1><p>{user?.email}</p><p role="alert">Check your connection and try again.</p><button className="primary modal-submit" onClick={() => window.location.reload()}>Try again</button><button className="account-button modal-submit" onClick={() => signOut(auth)}>Sign out</button></section></main>;

  return <main className="app-shell"><div className="grid-glow" /><div className="container">
    <header className="bar"><span className="wordmark"><span className="brand-mark"><Icon name="bolt" /></span>Meralpon</span><div className="bar-actions"><span className={`sync-pill ${guestMode ? "demo" : syncState}`}><span /> {guestMode ? "Sample" : syncState === "synced" ? "Saved" : syncState === "error" ? "Couldn’t save" : syncState === "offline" ? "Waiting for internet" : "Saving…"}</span><button className="account-button" onClick={() => setShowHelp(true)}>How it works</button>{user ? <><button className="account-button" onClick={() => signOut(auth)}>Sign out</button><button className="profile-pill" onClick={onProfile}><span>{(user.displayName || user.email || "U").slice(0, 1).toUpperCase()}</span>My account</button></> : <button className="account-button" onClick={onSignIn}>Sign in</button>}<button className="primary small" onClick={() => openAdd()}><Icon name="plus" /> Add reading</button></div></header>
    <h1 className="sr-only">Meralpon electricity tracker</h1>
    {guestMode && <div className="sample-strip"><p><b>You’re viewing sample data.</b> Change a reading and watch the estimate update. Nothing is saved.</p><button className="primary" onClick={onSignIn}>Create free account</button></div>}
    {!guestMode && !onboarding && periodExpired && <section className="setup-notice"><div><strong>Ready for your next bill?</strong><p>Choose your new dates and price per kWh, then add your first meter reading.</p></div><button className="primary" onClick={openPeriod}>Set up my tracker</button></section>}
    {legal && <Legal type={legal} onClose={() => setLegal(null)} />}
    {showHelp && <Tutorial onClose={() => setShowHelp(false)} onDemo={() => setShowHelp(false)} />}
    {onboarding && <section className="panel welcome"><h2>Welcome to Meralpon</h2><p>Two quick steps, then you’ll see your estimated bill.</p><ol className="welcome-steps"><li className={step1done ? "done" : ""}><span className="step-dot">{step1done ? <Icon name="check" /> : "1"}</span><div><strong>Set your bill dates and price</strong><small>Copy them from your electricity bill.</small></div>{!step1done && <button className="primary" onClick={openPeriod}>Set up</button>}</li><li><span className="step-dot">2</span><div><strong>Add your first meter reading</strong><small>Type the number, or use a photo below.</small></div><button className={step1done ? "primary" : "account-button"} disabled={!step1done} onClick={() => openAdd()}>Add reading</button></li></ol></section>}
    {!onboarding && spike && <div className="spike" role="status"><b>Higher than usual.</b> Your latest reading works out to about {number.format(spike.now)} kWh a day, compared with {number.format(spike.average)} kWh before. Worth checking for appliances left on.</div>}
    {!onboarding && <section className="hero" aria-label="Your electricity summary">
      <div className="hero-main">
        <div className="hero-meta"><button className="chip" onClick={openPeriod}>{periodLabel}<b>Edit</b></button><button className="chip" onClick={openPeriod}>{money.format(rate)}/kWh<b>Edit</b></button></div>
        <h2 className="label">Estimated bill</h2>
        <p className="hero-figure">{money.format(projectedCost)}</p>
        <p className="hero-sub">{wholeNumber.format(projectedUsage)} kWh projected by {shortDate(period.end)} · {remainingDays} {remainingDays === 1 ? "day" : "days"} left</p>
        <div className="meter-track" role="progressbar" aria-label="Billing period progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><i style={{ width: `${progress}%` }} /></div>
        <div className="track-labels"><span>{shortDate(period.start)}</span><span>Day {Math.min(elapsedPeriodDays, totalPeriodDays)} of {totalPeriodDays}</span><span>{shortDate(period.end)}</span></div>
        <dl className="hero-stats"><div><dt>Meter now</dt><dd>{latest.reading.toLocaleString("en-PH")} kWh</dd></div><div><dt>Used so far</dt><dd>{wholeNumber.format(cycleUsage)} kWh</dd></div><div><dt>Cost so far</dt><dd>{money.format(cycleCost)}</dd></div></dl>
      </div>
      <div className="hero-side">
        <article className="stat"><h3 className="label">Latest usage</h3><p className="stat-figure">{wholeNumber.format(latest.usage)}<small> kWh</small></p><p className="stat-note">{money.format(latest.cost)} · <span className={`change ${change <= 0 ? "good" : "warn"}`}>{previous ? `${change > 0 ? "+" : ""}${change.toFixed(0)}% vs previous` : "First reading"}</span></p></article>
        <article className="stat"><h3 className="label">Tomorrow’s estimate</h3><p className="stat-figure">{wholeNumber.format(forecastTomorrow)}<small> kWh</small></p><p className="stat-note">{money.format(forecastTomorrow * rate)} · based on recent usage</p></article>
      </div>
    </section>}
    <section className={`panel scan ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e: DragEvent<HTMLElement>) => { e.preventDefault(); setDragging(false); scan(e.dataTransfer.files[0]); }}>
      <input ref={fileRef} hidden type="file" accept="image/*" onClick={(event) => { event.currentTarget.value = ""; }} onChange={(e) => scan(e.target.files?.[0])} /><input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onClick={(event) => { event.currentTarget.value = ""; }} onChange={(e) => scan(e.target.files?.[0])} />
      <span className="camera"><Icon name="camera" /></span><div className="scan-copy"><h2>Read a meter photo</h2><p>Fill the frame with the meter digits, or drop a photo here. Check the number before saving.</p></div>
      <div className="capture-actions"><button type="button" className="outline-button camera-button" onClick={() => cameraRef.current?.click()}><Icon name="camera" /> Open camera</button><button type="button" className="outline-button" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Choose image</button></div>
    </section>
    {!onboarding && <>
    <section className="panel chart-panel"><div className="section-title"><div><h2>Daily usage</h2><p className="sub">Recent average: {wholeNumber.format(rollingAverage)} kWh a day</p></div></div>
      {selected && <p className="chart-detail" aria-live="polite"><strong>{new Date(`${selected.date}T12:00:00`).toLocaleDateString("en-PH", { month: "long", day: "numeric" })} · {selected.time}</strong><span>{selected.id === computed[0]?.id ? `Starting reading · ${selected.reading.toLocaleString("en-PH")} kWh` : `${number.format(selected.usage)} kWh used · ${money.format(selected.cost)} · meter ${selected.reading.toLocaleString("en-PH")}`}</span></p>}
      <div className="chart" role="group" aria-label="Usage at each reading. Select a bar for details.">{computed.map((item, index) => { const peak = Math.max(...computed.map((v) => v.usage), 1); return <button type="button" aria-pressed={selected?.id === item.id} onClick={() => setPicked(item.id)} className={`bar-col${selected?.id === item.id ? " latest" : ""}`} key={item.id}><span className="bar-value">{index === 0 ? "Start" : wholeNumber.format(item.usage)}</span><span className="bar-well"><i style={{ height: `${index === 0 ? 0 : Math.max(5, item.usage / peak * 100)}%` }} /></span><span className="bar-date">{shortDate(item.date)}</span></button>; })}</div>
    </section>
    <section className="panel ledger"><div className="ledger-head"><div><h2>Meter readings</h2><p>{computed.length} {guestMode ? "sample readings · changes are temporary" : "readings saved to this account"}</p></div><div className="ledger-actions"><button onClick={() => importRef.current?.click()}>Restore backup</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(e) => importJSON(e.target.files?.[0])}/><button onClick={() => exportFile("json")}><Icon name="download" /> Save backup</button><button onClick={() => exportFile("csv")}><Icon name="download" /> Spreadsheet</button></div></div><div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Meter reading</th><th>Daily usage</th><th>Daily cost</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{[...computed].reverse().map((r) => <tr key={r.id}><td data-label="Date"><strong>{new Date(`${r.date}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</strong><span>{r.time}</span></td><td data-label="Meter reading">{r.reading.toLocaleString("en-PH")} <small>kWh</small></td><td className="usage" data-label="Daily usage">{r.id === computed[0]?.id ? "—" : `+${number.format(r.usage)} kWh`}</td><td data-label="Daily cost">{r.id === computed[0]?.id ? "—" : money.format(r.cost)}</td><td className="notes" data-label="Notes">{r.notes || "—"}</td><td className="row-cell"><div className="row-actions"><button onClick={() => openEdit(r)} aria-label={`Edit reading from ${r.date}`}><Icon name="edit" /><span>Edit</span></button><button disabled={readings.length === 1} onClick={() => setConfirmation({ title: "Delete this reading?", detail: `The reading of ${r.reading.toLocaleString("en-PH")} kWh on ${r.date} will be removed. Your usage totals will update.`, action: "Delete reading", run: () => setReadings((list) => list.filter((x) => x.id !== r.id)) })} aria-label={`Delete reading from ${r.date}`}><Icon name="trash" /><span>Delete</span></button></div></td></tr>)}</tbody></table></div></section>
    <section className="panel history"><div className="section-title"><div><h2>Past bills</h2><p className="sub">{history.length ? "Each finished billing period, saved when you start a new one." : "Finished billing periods will appear here after you start a new one."}</p></div></div>
      {history.length > 0 && <ul className="history-list">{history.map((p, index) => { const older = history[index + 1]; const diff = older?.cost ? (p.cost - older.cost) / older.cost * 100 : null; return <li key={p.start}><div><strong>{shortDate(p.start)} – {shortDate(p.end)}</strong><small>{money.format(p.rate)}/kWh</small></div><div><strong>{money.format(p.cost)}</strong><small>{wholeNumber.format(p.used)} kWh used</small></div>{diff !== null && <span className={`change ${diff <= 0 ? "good" : "warn"}`}>{diff > 0 ? "+" : ""}{diff.toFixed(0)}% vs the bill before</span>}</li>; })}</ul>}
    </section>
    </>}
    <footer>{guestMode ? "Sample dashboard · No account needed · Changes are temporary" : "Your readings are private to your account"}<br />Estimated at {money.format(rate)} per kWh. Your actual bill may include other charges.<div className="policy-links"><button onClick={() => setLegal("terms")}>Terms of use</button><button onClick={() => setLegal("privacy")}>Privacy notice</button></div></footer>
  </div>
  {(modal === "add" || modal === "edit") && <Modal title={modal === "edit" ? "Edit reading" : "Add a reading"} onClose={() => setModal(null)}><ReadingForm error={formError} form={form} setForm={setForm} submit={submit} label={modal === "edit" ? "Save changes" : "Add to log"} /></Modal>}
  {confirmation && <Modal title={confirmation.title} onClose={() => setConfirmation(null)}><p className="period-help">{confirmation.detail}</p><div className="tour-controls"><button className="account-button" onClick={() => setConfirmation(null)}>Cancel</button><button className="danger-button" onClick={() => { confirmation.run(); setConfirmation(null); }}>{confirmation.action}</button></div></Modal>}
  {notice && <div className="toast" role="status">{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}
  {modal === "ocr" && <Modal title="Check the number" onClose={() => setModal(null)}><div className="scan-preview">{preview && <img src={preview} alt="Uploaded meter" />}<div className="scan-status"><span style={{ width: `${ocrProgress * 100}%` }} /></div><p>{ocrStatus}</p></div><ReadingForm error={formError} form={form} setForm={setForm} submit={submit} label="Confirm & save" /></Modal>}
  {modal === "period" && <Modal title={periodExpired ? "Start a new billing period" : periodConfigured ? "Billing settings" : "Set your billing period"} onClose={() => periodConfigured && !periodExpired && setModal(null)}><form className="reading-form" onSubmit={savePeriod}><p className="period-help">Set the dates shown on your bill and your current electricity price. These settings are saved to your account.</p><div className="field-row"><div className="field"><label htmlFor="period-start">Billing start</label><input id="period-start" type="date" required value={periodForm.start} onChange={(e) => setPeriodForm((value: typeof DEFAULT_PERIOD) => ({ ...value, start: e.target.value }))}/></div><div className="field"><label htmlFor="period-end">Billing end</label><input id="period-end" type="date" required min={periodForm.start} value={periodForm.end} onChange={(e) => setPeriodForm((value: typeof DEFAULT_PERIOD) => ({ ...value, end: e.target.value }))}/></div></div><div className="field featured rate-field"><label htmlFor="rate">Electricity rate</label><div><span>₱</span><input id="rate" type="number" required min="0.0001" step="0.0001" inputMode="decimal" value={rateForm} onChange={(event) => setRateForm(event.target.value)} /><span>per kWh</span></div></div><button className="primary modal-submit" type="submit">Save billing settings</button>{user && <button className="danger-link" type="button" onClick={askResetAccount}>Reset this account and delete all readings</button>}</form></Modal>}
  </main>;
}

function VerifyEmailScreen({ user, onVerified }: { user: User; onVerified: () => void }) {
  const [message, setMessage] = useState("Open the link in your email to continue. If you need a new link, use the button below.");
  const [busy, setBusy] = useState(false);

  const checkVerification = async () => {
    setBusy(true);
    try {
      await reload(user);
      if (user.emailVerified) { await user.getIdToken(true); onVerified(); }
      else setMessage("We haven’t confirmed it yet. Open the link in your email, then check again.");
    } catch { setMessage("Could not check right now. Please try again."); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    setBusy(true);
    try { await sendEmailVerification(user); setMessage("A new confirmation email was sent. Check your inbox and spam folder."); }
    catch { setMessage("Please wait before requesting another email, then try again."); }
    finally { setBusy(false); }
  };

  return <main className="app-shell auth-shell"><div className="grid-glow" /><section className="auth-card verify-card"><span className="verify-icon">@</span><h1>Confirm your email</h1><p>Your private readings will open after <b>{user.email}</b> is confirmed.</p><div className="verify-message">{message}</div><button className="primary modal-submit" disabled={busy} onClick={checkVerification}>{busy ? "Checking…" : "I clicked the email link"}</button><div className="guest-actions"><button type="button" disabled={busy} onClick={resend}>Resend email</button><button type="button" onClick={() => signOut(auth)}>Sign out</button></div></section></main>;
}

function Tutorial({ onClose, onDemo }: { onClose: () => void; onDemo: () => void }) {
  return <GuidedTour onClose={onClose} />;
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
  const [accepted, setAccepted] = useState(false);
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);

  const authenticate = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "signup" && !accepted) { setError("Please read and accept the terms and privacy notice."); return; }
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
      setError(code.includes("invalid-credential") ? "Incorrect email or password." : code.includes("email-already-in-use") ? "That email already has an account. Sign in instead." : code.includes("weak-password") ? "Use a stronger password with at least 6 characters." : code.includes("too-many-requests") ? "Too many attempts. Please wait a moment and try again." : "Could not continue. Please try again in a moment.");
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

  return <main className="app-shell auth-shell"><div className="grid-glow" /><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Icon name="bolt" /></span><div><h1>Meralpon</h1></div></div><p className="auth-intro">Your readings, billing period, and estimates—saved to your account on every device.</p><div className="auth-tabs" role="tablist" aria-label="Account access"><button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "active" : ""} onClick={() => changeMode("signin")}>Sign in</button><button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} onClick={() => changeMode("signup")}>Create account</button></div><form className="reading-form auth-form" onSubmit={authenticate}><div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></div><div className="field"><div className="password-label"><label htmlFor="auth-password">Password</label>{mode === "signin" && <button type="button" onClick={resetPassword}>Forgot password?</button>}</div><div className="password-input"><input id="auth-password" type={showPassword ? "text" : "password"} required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "At least 6 characters" : "Enter your password"}/><button type="button" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></div>{mode === "signup" && <div className="field"><label htmlFor="auth-confirm-password">Confirm password</label><div className="password-input"><input id="auth-confirm-password" type={showPassword ? "text" : "password"} required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter it again"/></div></div>}{mode === "signup" && <div className="consent"><label><input type="checkbox" required checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> I agree to the terms of use and have read the privacy notice.</label><div className="policy-links"><button type="button" onClick={() => setLegal("terms")}>Read terms</button><button type="button" onClick={() => setLegal("privacy")}>Read privacy notice</button></div></div>}{error && <p className="auth-error">{error}</p>}{notice && <p className="auth-notice">{notice}</p>}<button className="primary modal-submit auth-submit" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in to dashboard"}</button></form><div className="guest-actions"><button type="button" onClick={onDemo}>Back to sample dashboard</button><button type="button" onClick={() => setShowTutorial(true)}>How it works</button></div><p className="auth-security">Your readings are private to your account.</p></section>{legal && <Legal type={legal} onClose={() => setLegal(null)} />}{showTutorial && <Tutorial onClose={() => setShowTutorial(false)} onDemo={() => { setShowTutorial(false); onDemo(); }} />}</main>;
}

function ReadingForm({ form, setForm, submit, label, error }: { error?: string; form: { date: string; time: string; reading: string; notes: string }; setForm: React.Dispatch<React.SetStateAction<{ date: string; time: string; reading: string; notes: string }>>; submit: (e: FormEvent) => void; label: string }) {
  return <form onSubmit={submit} className="reading-form"><div className="field featured"><label htmlFor="reading">Meter reading</label><div><input id="reading" autoFocus required inputMode="numeric" pattern="[0-9]*" value={form.reading} onChange={(e) => setForm((f) => ({ ...f, reading: e.target.value.replace(/\D/g, "").slice(0, 8) }))} placeholder="00000"/><span>kWh</span></div></div><div className="field-row"><div className="field"><label htmlFor="date">Date</label><input id="date" type="date" required value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}/></div><div className="field"><label htmlFor="time">Time</label><input id="time" type="time" required value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}/></div></div><div className="field"><label htmlFor="notes">Notes <span>optional</span></label><input id="notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Aircon used overnight"/></div>{error && <p className="auth-error" role="alert">{error}</p>}<button className="primary modal-submit" type="submit">{label}</button></form>;
}
