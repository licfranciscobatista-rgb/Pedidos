import { redirect } from "next/navigation";
import { authConfiguration } from "@/lib/auth/config";
import { setupState } from "@/lib/auth/session";
import SetupForm from "./setup-form";
import styles from "../login/login.module.css";
export const dynamic = "force-dynamic";
export default async function SetupPage() {
  const config = authConfiguration(process.env);
  const state = await setupState(config);
  if (state === "complete") redirect("/login");
  return <main className={styles.screen}><section className={styles.card} aria-labelledby="setup-heading">
    <a className={styles.brand} href="/login">mi encargo<span>.</span></a><p className={styles.eyebrow}>TU ESPACIO PRIVADO</p>
    <div className={styles.icon} aria-hidden="true">✽</div><h1 id="setup-heading">Crea tu acceso</h1>
    <p className={styles.intro}>Elige la contraseña de tu usuario. Solo necesitarás este paso la primera vez.</p>
    {state === "ready" ? <SetupForm ownerUsername={config!.ownerUsername}/> : <div className={styles.setup} role="status"><strong>La instalación está pendiente.</strong><p>Falta completar la configuración del servidor antes de crear tu contraseña.</p></div>}
    <p className={styles.footer}>Guarda tu contraseña en un lugar seguro.</p>
  </section></main>;
}
