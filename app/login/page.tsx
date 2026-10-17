import { redirect } from "next/navigation";
import { getAppUser } from "@/app/auth";
import { authConfiguration } from "@/lib/auth/config";
import { setupState } from "@/lib/auth/session";
import LoginForm from "./login-form";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getAppUser()) redirect("/");
  const config = authConfiguration(process.env);
  const state = await setupState(config);
  return <main className={styles.screen}>
    <section className={styles.card} aria-labelledby="login-heading">
      <a className={styles.brand} href="/login">mi encargo<span>.</span></a>
      <p className={styles.eyebrow}>TUS PEDIDOS, EN ORDEN</p>
      <div className={styles.icon} aria-hidden="true">✽</div>
      <h1 id="login-heading">Entra a tu espacio</h1>
      <p className={styles.intro}>Tus artículos, fotos y cuentas, disponibles desde el celular y la computadora.</p>
      {state === "complete" ? <LoginForm ownerUsername={config!.ownerUsername}/> : state === "ready" ? <div className={styles.setup}><strong>Elige tu contraseña para comenzar.</strong><p>La instalación está lista. Completa la creación del usuario con tu clave de instalación.</p><a className={styles.submit} href="/setup">Crear mi acceso</a></div> : <div className={styles.setup} role="status"><strong>Estamos preparando tu acceso.</strong><p>La instalación todavía necesita completar la configuración del usuario autorizado. Tus datos permanecen privados.</p></div>}
      <p className={styles.footer}>Acceso privado · Precios en pesos dominicanos</p>
    </section>
  </main>;
}
