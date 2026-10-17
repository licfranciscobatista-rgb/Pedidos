"use client";

import { useMemo, useState } from "react";
import { ArrowRight, FileSpreadsheet, History, Search, ShoppingBag, Wallet, X } from "lucide-react";
import type { Activity } from "@/lib/types";

type Category = "Pedidos" | "Pagos" | "Cambios" | "Facturas" | "Importaciones" | "Otros";
const filters = ["Todos", "Pedidos", "Pagos", "Cambios", "Facturas", "Importaciones"] as const;
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
function categoryOf(kind: string): Category {
  const key = normalize(kind);
  if (/import|excel/.test(key)) return "Importaciones";
  if (/invoice|factura|receipt|recibo/.test(key)) return "Facturas";
  if (/exchange|cambio/.test(key)) return "Cambios";
  if (/payment|pago|abono|devolucion|refund/.test(key)) return "Pagos";
  if (/order|pedido|articulo/.test(key)) return "Pedidos";
  return "Otros";
}
function dateParts(at: string) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return { day: "Fecha no disponible", time: at, search: at };
  return {
    day: date.toLocaleDateString("es-DO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    time: date.toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" }),
    search: `${at} ${date.toLocaleDateString("es-DO")} ${date.toLocaleDateString("es-DO", { day: "numeric", month: "long", year: "numeric" })}`,
  };
}
function CategoryIcon({ category }: { category: Category }) {
  if (category === "Pagos") return <Wallet size={17} aria-hidden="true" />;
  if (category === "Importaciones" || category === "Facturas") return <FileSpreadsheet size={17} aria-hidden="true" />;
  if (category === "Pedidos") return <ShoppingBag size={17} aria-hidden="true" />;
  return <History size={17} aria-hidden="true" />;
}

export default function HistoryPanel({ activities, onOpenOrder, orderIds }: { activities: Activity[]; onOpenOrder: (id: string) => void; orderIds: string[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<typeof filters[number]>("Todos");
  const [limit, setLimit] = useState(50);
  const knownOrders = useMemo(() => new Set(orderIds), [orderIds]);
  const items = useMemo(() => activities.map(activity => ({ ...activity, category: categoryOf(activity.kind), date: dateParts(activity.at) })).sort((a, b) => b.at.localeCompare(a.at)), [activities]);
  const query = normalize(search);
  const matched = items.filter(item => (filter === "Todos" || item.category === filter) && (!query || normalize(`${item.client} ${item.summary} ${item.detail} ${item.kind} ${item.category} ${item.orderId} ${item.date.day} ${item.date.search}`).includes(query)));
  const visible = matched.slice(0, limit);
  return <section className="history-panel" aria-labelledby="history-title">
    <div className="section-heading"><div><h2 id="history-title">Historial de movimientos</h2><p>Pedidos, pagos, cambios y facturas, en el orden en que ocurrieron.</p></div></div>
    <div className="history-toolbar">
      <div className="filter-tabs history-filters" role="group" aria-label="Filtrar historial por tipo">{filters.map(label => <button key={label} type="button" className={filter === label ? "active" : ""} aria-pressed={filter === label} onClick={() => { setFilter(label); setLimit(50); }}>{label}</button>)}</div>
      <label className="search-input history-search"><Search size={17} aria-hidden="true" /><input type="search" value={search} onChange={event => { setSearch(event.target.value); setLimit(50); }} placeholder="Buscar cliente, artículo, tipo o fecha" aria-label="Buscar en el historial" />{search && <button type="button" onClick={() => { setSearch(""); setLimit(50); }} aria-label="Limpiar búsqueda"><X size={14} /></button>}</label>
    </div>
    <p className="history-scope">Se muestran los últimos 500 movimientos como máximo. Las fechas y horas corresponden a este dispositivo.</p>
    <div className="orders-panel history-list">
      {!activities.length ? <div className="empty-state compact"><History size={32} aria-hidden="true" /><h3>Tu historial empieza aquí</h3><p>Los nuevos pedidos, pagos, cambios, facturas e importaciones aparecerán aquí al guardarlos.</p></div> : !matched.length ? <div className="empty-state compact"><Search size={29} aria-hidden="true" /><h3>No encontramos movimientos</h3><p>Prueba otro nombre, fecha o tipo de movimiento.</p><button type="button" className="button button-secondary" onClick={() => { setSearch(""); setFilter("Todos"); setLimit(50); }}>Ver todo el historial</button></div> : <ol className="history-timeline">{visible.map((item, index) => <li className="history-entry" key={item.id}>
        {(index === 0 || visible[index - 1].date.day !== item.date.day) && <h3 className="history-day">{item.date.day}</h3>}
        <article className="history-item"><div className={`history-icon history-icon-${item.category === "Pagos" ? "payment" : item.category === "Facturas" ? "invoice" : "order"}`}><CategoryIcon category={item.category} /></div><div className="history-content"><div className="history-item-top"><span className="history-category">{item.category === "Otros" ? "Actividad" : item.category}</span><time dateTime={item.at}>{item.date.time}</time></div><h4>{item.summary || "Movimiento registrado"}</h4>{item.client && <p className="history-client">{item.client}</p>}{item.detail && <p className="history-detail">{item.detail}</p>}{item.orderId && <div className="history-order">{knownOrders.has(item.orderId) ? <button type="button" className="text-button" onClick={() => onOpenOrder(item.orderId)}>Ver artículo <ArrowRight size={13} aria-hidden="true" /></button> : <span>El artículo ya no está disponible.</span>}<small>{item.orderId}</small></div>}</div></article>
      </li>)}</ol>}
      {!!matched.length && <div className="history-footer"><span aria-live="polite">{visible.length} de {matched.length} movimientos{filter !== "Todos" || query ? " encontrados" : " recientes"}</span>{visible.length < matched.length && <button type="button" className="button button-secondary" onClick={() => setLimit(value => value + 50)}>Ver 50 más</button>}</div>}
    </div>
  </section>;
}
