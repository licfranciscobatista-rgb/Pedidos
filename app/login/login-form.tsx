"use client";
import { useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import styles from "./login.module.css";

export default function LoginForm({ ownerUsername }: { ownerUsername: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "No pudimos completar el acceso. Inténtalo nuevamente.");
      window.location.assign("/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No pudimos completar el acceso. Inténtalo nuevamente."); setBusy(false); }
  }
  return <><form onSubmit={signIn} className={styles.form}>
    <label className={styles.field}>Usuario<div className={styles.inputWrap}><UserRound size={19} aria-hidden="true"/><input name="username" autoComplete="username" defaultValue={ownerUsername} required maxLength={40} disabled={busy}/></div></label>
    <label className={styles.field}>PIN<div className={styles.inputWrap}><LockKeyhole size={19} aria-hidden="true"/><input name="password" type="password" autoComplete="current-password" placeholder="Tu PIN de 4 dígitos" inputMode="numeric" required maxLength={256} disabled={busy}/></div></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button type="submit" className={styles.submit} disabled={busy}>{busy ? <LoaderCircle size={18} className="spin"/> : <ShieldCheck size={18}/>} {busy ? "Un momento…" : "Entrar a mis pedidos"}{!busy && <ArrowRight size={17}/>}</button>
  </form><p className={styles.hint}><ShieldCheck size={16} aria-hidden="true"/> Tu sesión es privada. Ciérrala si utilizas un dispositivo compartido.</p></>;
}
