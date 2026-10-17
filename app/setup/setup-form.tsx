"use client";
import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import styles from "../login/login.module.css";

export default function SetupForm({ ownerUsername }: { ownerUsername: string }) {
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // URL fragments never reach server access logs. Remove it after reading.
    const params = new URLSearchParams(window.location.hash.slice(1));
    const supplied = params.get("setup");
    if (supplied) setSetupToken(supplied);
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (password !== confirmPassword) { setError("Las contraseñas no coinciden."); return; }
    if ([...password].length < 12 || new TextEncoder().encode(password).byteLength > 256) { setError("Crea una contraseña de al menos 12 caracteres y un máximo de 256 bytes."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password, confirmPassword, setupToken }) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "No pudimos crear el acceso. Inténtalo nuevamente.");
      setSetupToken(""); window.location.assign("/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No pudimos crear el acceso. Inténtalo nuevamente."); setBusy(false); }
  }
  return <form onSubmit={submit} className={styles.form}>
    <label className={styles.field}>Usuario<div className={styles.inputWrap}><UserRound size={18} aria-hidden="true"/><input name="username" defaultValue={ownerUsername} autoComplete="username" required readOnly disabled={busy}/></div></label>
    <label className={styles.field}>Clave de instalación<div className={styles.inputWrap}><ShieldCheck size={18} aria-hidden="true"/><input name="setupToken" type="password" autoComplete="off" value={setupToken} onChange={event => setSetupToken(event.target.value)} placeholder="La clave recibida con tu instalación" required minLength={32} maxLength={256} disabled={busy}/></div></label>
    <label className={styles.field}>Tu nueva contraseña<div className={styles.inputWrap}><LockKeyhole size={18} aria-hidden="true"/><input name="password" type="password" autoComplete="new-password" placeholder="Al menos 12 caracteres" required minLength={12} maxLength={256} disabled={busy}/></div></label>
    <label className={styles.field}>Repite la contraseña<div className={styles.inputWrap}><LockKeyhole size={18} aria-hidden="true"/><input name="confirmPassword" type="password" autoComplete="new-password" placeholder="Escríbela otra vez" required minLength={12} maxLength={256} disabled={busy}/></div></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button type="submit" className={styles.submit} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <ShieldCheck size={18}/>} {busy ? "Creando tu acceso…" : "Guardar contraseña y entrar"}</button>
  </form>;
}
