export const STATUSES = ["Pendiente", "Pedido", "En camino", "Recibido", "Entregado", "Cancelado", "Cambiado"] as const;
export type OrderStatus = typeof STATUSES[number];
export type Order = {
  id: string; client: string; phone: string; batch: string; article: string;
  variant: string; quantity: number; unitCents: number; extraCents: number;
  discountCents: number; status: OrderStatus; date: string; notes: string;
  photoKey: string; revision: number; platform: "Temu" | "SHEIN";
  storeCents: number; deliveryDate: string;
};
export type Payment = {
  id: string; orderId: string; amountCents: number; date: string;
  method: string; note: string; kind: "Abono" | "Devolución";
};
export type Exchange = {
  id: string; orderId: string; date: string; oldArticle: string; newArticle: string;
  oldTotalCents: number; newTotalCents: number; differenceCents: number; note: string;
};
export type Activity = {
  id: string; at: string; kind: string; orderId: string;
  client: string; summary: string; detail: string;
};
export type InvoiceItem = {
  orderId: string; article: string; variant: string; quantity: number;
  unitCents: number; extraCents: number; discountCents: number;
  totalCents: number; status: OrderStatus; platform: "Temu" | "SHEIN";
  deliveryLabel: "Llega en esta entrega" | "Sigue pendiente" | "Ya entregado" | "Por confirmar";
};
export type Invoice = {
  id: string; number: string; issuedAt: string; client: string; phone: string;
  businessName: string; notes: string; orderIds: string[]; items: InvoiceItem[];
  totalCents: number; paidCents: number; balanceCents: number;
  pricingMode: "items" | "manual"; showAmounts: boolean; registeredTotalCents: number;
};
export function orderTotal(order: Order): number {
  return order.status === "Cancelado" ? 0 : order.quantity * order.unitCents + order.extraCents - order.discountCents;
}
export function paidFor(orderId: string, payments: Payment[]): number {
  return payments.filter(p => p.orderId === orderId).reduce((sum, p) => sum + (p.kind === "Devolución" ? -p.amountCents : p.amountCents), 0);
}
