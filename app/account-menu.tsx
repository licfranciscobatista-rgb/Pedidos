"use client";

import { useState } from "react";
import { LogOut, LoaderCircle } from "lucide-react";

export default function AccountMenu() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("No pudimos cerrar la sesión. Inténtalo nuevamente.");
      window.location.assign("/login");
    } catch { setError("No pudimos cerrar la sesión. Inténtalo nuevamente."); setBusy(false); }
  }
  return <div style={{ position: "relative" }}><button className="icon-button" type="button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={() => void signOut()} disabled={busy}>{busy ? <LoaderCircle size={18} className="spin"/> : <LogOut size={19}/>}</button>{error && <p role="alert" style={{ position: "absolute", right: 0, top: 44, width: 240, padding: 12, background: "#fff7ec", color: "#8c442f", borderRadius: 8, zIndex: 20, fontSize: 13 }}>{error}</p>}</div>;
}
