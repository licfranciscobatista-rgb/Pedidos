"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export const money = (cents: number) => `RD$ ${(cents / 100).toLocaleString("es-DO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const today = () => new Date().toLocaleDateString("en-CA");
export const dateLabel = (value?: string) => value ? new Date(value.includes("T") ? value : `${value}T12:00:00`).toLocaleDateString("es-DO", { day: "numeric", month: "short", year: "numeric" }) : "Sin fecha";
export const norm = (value: string) => value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
export async function businessApi<T = unknown>(url: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "No se pudo guardar. Vuelve a intentarlo.");
  return result as T;
}
export function BusinessDialog({ title, children, onClose, wide = false, busy = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const oldFocus = document.activeElement as HTMLElement | null, oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; ref.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab") return;
      const targets = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
      if (!targets?.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", keyboard); oldFocus?.focus(); };
  }, [busy, onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div ref={ref} className={`modal business-dialog ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="business-dialog-title" tabIndex={-1}><div className="modal-header"><div><p className="eyebrow">MI ENCARGO · REGISTROS</p><h2 id="business-dialog-title">{title}</h2></div><button className="icon-button" type="button" aria-label="Cerrar ventana" disabled={busy} onClick={onClose}><X size={20}/></button></div>{children}</div></div>, document.body);
}
