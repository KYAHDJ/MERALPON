import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { deleteUser, EmailAuthProvider, reauthenticateWithCredential, sendPasswordResetEmail, updateProfile, type User } from "firebase/auth";
import { doc, getDoc, setDoc, waitForPendingWrites, writeBatch } from "firebase/firestore";
import { auth, db } from "./firebase";
import { deletionPaths } from "./deletion-plan.mjs";

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || []).filter((item) => item.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keyboard); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={panel} className="modal experience-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="modal-head"><div><p className="kicker">Meralpon</p><h2>{title}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div>{children}
    </section>
  </div>;
}

export function Legal({ type, onClose }: { type: "terms" | "privacy"; onClose: () => void }) {
  return <Dialog title={type === "terms" ? "Terms of use" : "Privacy notice"} onClose={onClose}><div className="legal-copy"><p className="version-label">Last updated October 9, 2026</p>{type === "terms" ? <>
    <h3>A personal electricity tracker</h3><p>Meralpon helps you record meter readings and estimate electricity costs. It is an independent project, not an official Meralco service.</p>
    <h3>Estimates, not an official bill</h3><p>Estimates use the readings and price you enter. They may differ from your actual bill, which can include other charges. Check photo readings before saving and refer to your electricity provider for billing questions.</p>
    <h3>Your account</h3><p>Use an email you own, keep your password private, and only enter data you have permission to use. Do not attempt to access another person’s account or disrupt the service.</p>
    <h3>Your data and choices</h3><p>You can download your readings, correct them, or delete your account in My account. Account deletion removes your login, readings, settings, and the recovery copy held by this app. Keep a downloaded backup if you need one.</p>
    <h3>Availability</h3><p>Saving between devices needs an internet connection. The service may be unavailable at times; keep your own backup of important readings.</p>
  </> : <>
    <h3>What is saved</h3><p>Your email and sign-in details are handled by Firebase Authentication. Your meter readings, dates, notes, bill dates, and electricity price are stored in your private account using Cloud Firestore. An optional profile name is stored with your login.</p>
    <h3>Photos and the sample dashboard</h3><p>Meter photos are processed in your browser. This app does not save those photos to your account. The photo reader downloads its recognition software and language files. Sample dashboard changes are temporary.</p>
    <h3>Browser storage</h3><p>Your browser remembers your signed-in session. The tracker does not store your password in its own files or share readings between accounts. Downloaded backups remain on the device where you saved them.</p>
    <h3>Services used</h3><p>GitHub Pages serves the website. Google Firebase provides account and reading storage. These providers process connection information as part of operating their services. This app does not enable advertising or analytics tracking.</p>
    <h3>Delete your information</h3><p>My account lets you permanently remove the login and all account data stored by this app, including its recovery copy. Files you downloaded yourself are not removed. Provider security logs may follow the provider’s own retention practices.</p>
  </>}</div><button className="primary modal-submit" onClick={onClose}>Done</button></Dialog>;
}

const steps = [
  { title: "Make sense of your next bill", text: "Start with the dates on your electricity bill and your price per kWh. You can change both using Manage beside the bill dates.", tag: "01 / Your bill", illustration: "dates", tip: "kWh is the unit your meter uses to measure electricity." },
  { title: "Start with the meter number", text: "Add your first reading as the starting point. Each new reading is compared with the one before it to find how much electricity you used.", tag: "02 / Your readings", illustration: "reading", tip: "Example: 8,873 − 8,869 = 4 kWh used." },
  { title: "Take a photo or type it in", text: "Use Open camera or Choose image. Keep the digits sharp and close, then check the suggested number before saving. You can always type the number yourself.", tag: "03 / Your photo", illustration: "photo", tip: "Avoid reflections, shadows, and angled photos." },
  { title: "See what your bill could be", text: "The circle shows your latest meter number, an estimated final reading, and estimated cost. The ring follows the days in your billing period.", tag: "04 / Your estimate", illustration: "estimate", tip: "Estimates become more useful as you add regular readings." },
  { title: "Your readings, wherever you are", text: "Use the same confirmed account on another device. Save a backup from Meter readings, and manage your profile or delete your account in My account.", tag: "05 / Your account", illustration: "account", tip: "The sample dashboard is separate from every real account." },
];
export function GuidedTour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const current = steps[step];
  return <Dialog title="A quick look around" onClose={onClose}>
    <div className="tour-progress" aria-label={"Step " + (step + 1) + " of " + steps.length}>{steps.map((item, index) => <button key={item.tag} aria-label={"Go to step " + (index + 1)} aria-current={index === step ? "step" : undefined} className={index <= step ? "complete" : ""} onClick={() => setStep(index)} />)}</div>
    <div className="tour-slide" key={step}>
      <div className={"tour-visual " + current.illustration} aria-hidden="true">{step === 0 ? <><span>YOUR BILL DATES</span><strong>29 SEP <i>→</i> 28 OCT</strong><small>A clear start. A clear finish.</small></> : step === 1 ? <><span>METER READING</span><strong className="meter-digits">0 8 8 7 3</strong><small>+4 kWh since your last reading</small></> : step === 2 ? <><span className="focus-frame">0 8 8 7 3</span><small>Point · Capture · Check</small></> : step === 3 ? <><div className="tour-ring">₱<small>Your estimate</small></div></> : <><span className="tour-avatar">You</span><small>One account. All your devices.</small></>}</div>
      <p className="kicker">{current.tag}</p><h3>{current.title}</h3><p>{current.text}</p><div className="tour-tip">{current.tip}</div>
    </div>
    <div className="tour-controls"><button className="account-button" onClick={() => step ? setStep(step - 1) : onClose()}>{step ? "Back" : "Skip for now"}</button><button className="primary" onClick={() => step === steps.length - 1 ? onClose() : setStep(step + 1)}>{step === steps.length - 1 ? "Ready to explore" : "Next step →"}</button></div>
  </Dialog>;
}

export default function AccountPanel({ user, onClose }: { user: User; onClose: () => void }) {
  const [name, setName] = useState(user.displayName || "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [dataRemoved, setDataRemoved] = useState(false);
  const [deletionStarted, setDeletionStarted] = useState(false);
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);
  const saveName = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await updateProfile(user, { displayName: name.trim().slice(0, 60) }); setMessage("Your name has been updated."); }
    catch { setMessage("We couldn’t save your name. Please try again."); }
    finally { setBusy(false); }
  };
  const resetPassword = async () => {
    if (!user.email) return;
    setBusy(true);
    try { await sendPasswordResetEmail(auth, user.email); setMessage("Check your inbox for a password reset link."); }
    catch { setMessage("We couldn’t send the email. Please try again later."); }
    finally { setBusy(false); }
  };
  const download = async () => {
    setBusy(true);
    try {
      const snapshot = await getDoc(doc(db, "users", user.uid, "tracker", "state"));
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot.data()?.readings || [], null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "meralpon-readings.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Your readings have been downloaded.");
    } catch { setMessage("We couldn’t download your readings. Please try again."); }
    finally { setBusy(false); }
  };
  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (confirmation !== "DELETE" || !user.email || auth.currentUser?.uid !== user.uid) return;
    setBusy(true); setMessage("");
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      setDeletionStarted(true);
      await waitForPendingWrites(db);
      await setDoc(doc(db, "users", user.uid, "tracker", "state"), { deleting: true, ownerUid: user.uid }, { merge: true });
      const batch = writeBatch(db);
      for (const path of deletionPaths(user.uid)) batch.delete(doc(db, path[0], ...path.slice(1)));
      await batch.commit();
      setDataRemoved(true);
      await deleteUser(user);
    } catch (error) {
      const code = (error as { code?: string }).code;
      setMessage(code === "auth/invalid-credential" || code === "auth/wrong-password"
        ? "That password was not accepted. Please try again."
        : "Deletion did not finish. Keep this page open and try again. Some data may already have been removed.");
    } finally { setBusy(false); setPassword(""); }
  };
  return <main className="app-shell profile-shell"><section className="profile-page">
    <button className="back-link" disabled={busy || deletionStarted} onClick={onClose}>← Back to your tracker</button>
    <div className="profile-heading"><div className="profile-avatar">{(name || user.email || "U").slice(0, 1).toUpperCase()}</div><div><p className="kicker">Your personal space</p><h1>My account</h1><p>{user.email}</p></div><span className="confirmed-badge">✓ Email confirmed</span></div>
    {message && <p className="account-message" role="status">{message}</p>}
    {!deletionStarted && <div className="profile-grid"><section className="panel"><p className="kicker">About you</p><h2>A name to call you</h2><form className="reading-form" onSubmit={saveName}><div className="field"><label htmlFor="profile-name">Your name <span>optional</span></label><input id="profile-name" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="What should we call you?" /></div><button className="primary" disabled={busy}>Save name</button></form></section>
    <section className="panel"><p className="kicker">Account & privacy</p><h2>You’re in control</h2><div className="profile-action"><div><strong>Password</strong><p>Get a link to choose a new password.</p></div><button className="account-button" disabled={busy} onClick={resetPassword}>Send reset link</button></div><div className="profile-action"><div><strong>Your readings</strong><p>Keep a copy on this device.</p></div><button className="account-button" disabled={busy} onClick={download}>Download</button></div><div className="policy-links"><button onClick={() => setLegal("terms")}>Terms of use</button><button onClick={() => setLegal("privacy")}>Privacy notice</button></div></section></div>}
    <section className="panel delete-panel"><p className="kicker">Leaving Meralpon?</p><h2>Delete this account</h2><p>This permanently removes <strong>{user.email}</strong>, its readings, bill settings, and recovery copy. Other accounts are unaffected.</p>
    {!deleting ? <button className="danger-button" onClick={() => setDeleting(true)}>Delete my account…</button> : <form className="reading-form" onSubmit={remove}>
      <p className="delete-warning">{dataRemoved ? "Your readings have been removed. Enter your password again to finish removing the login." : "This cannot be undone. Download a copy above first if you want to keep your readings."}</p>
      <div className="field"><label htmlFor="delete-password">Current password</label><input id="delete-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}/></div>
      <div className="field"><label htmlFor="delete-confirm">Type DELETE to confirm</label><input id="delete-confirm" required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" disabled={busy} /></div>
      <div className="tour-controls">{!deletionStarted && <button className="account-button" type="button" disabled={busy} onClick={() => { setDeleting(false); setPassword(""); setConfirmation(""); }}>Keep my account</button>}<button className="danger-button" disabled={busy || confirmation !== "DELETE" || !password}>{busy ? "Deleting your account…" : "Permanently delete my account"}</button></div>
    </form>}</section>
    {legal && <Legal type={legal} onClose={() => setLegal(null)} />}
  </section></main>;
}
