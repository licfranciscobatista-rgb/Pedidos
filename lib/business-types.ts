export const QUOTE_STATUSES = ["Borrador", "Enviada", "Aceptada", "Rechazada", "Vencida"] as const;
export const DELIVERY_LABELS = ["Llega en esta entrega", "Sigue pendiente", "Ya entregado", "Por confirmar"] as const;
export type DeliveryLabel = typeof DELIVERY_LABELS[number];
export type Client = { id: string; name: string; phone: string; email: string; address: string; notes: string; active: boolean; revision: number; createdAt?: string; updatedAt?: string };
export type QuoteItem = { id: string; article: string; variant: string; platform: "Temu" | "SHEIN"; quantity: number; unitCents: number; extraCents: number; discountCents: number };
export type Quote = { id: string; clientId: string; date: string; validUntil: string; status: typeof QUOTE_STATUSES[number]; notes: string; revision: number; items: QuoteItem[]; totalCents: number; createdAt?: string; updatedAt?: string };
export type InvoiceDraft = { id: string; clientId: string; date: string; businessName: string; notes: string; pricingMode: "items" | "manual"; manualTotalCents: number; showAmounts: boolean; revision: number; items: { orderId: string; deliveryLabel: DeliveryLabel }[]; issuedInvoiceId?: string; createdAt?: string; updatedAt?: string };
export type BusinessData = { clients: Client[]; quotes: Quote[]; invoiceDrafts: InvoiceDraft[] };
