import { sql } from "drizzle-orm";
import { bigint, bigserial, check, foreignKey, index, integer, primaryKey, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const orders = pgTable("orders", {
  ownerId: text("owner_id").notNull(),
  id: text("id").notNull(),
  platform: text("platform").notNull().default("Temu"),
  client: text("client").notNull(),
  phone: text("phone").notNull().default(""),
  batch: text("batch").notNull().default(""),
  article: text("article").notNull(),
  variant: text("variant").notNull().default(""),
  quantity: integer("quantity").notNull(),
  unitCents: bigint("unit_cents", { mode: "number" }).notNull(),
  extraCents: bigint("extra_cents", { mode: "number" }).notNull().default(0),
  discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
  storeCents: bigint("store_cents", { mode: "number" }).notNull().default(0),
  status: text("status").notNull().default("Pendiente"),
  date: text("date").notNull(),
  deliveryDate: text("delivery_date").notNull().default(""),
  notes: text("notes").notNull().default(""),
  photoKey: text("photo_key").notNull().default(""),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  index("orders_owner_date_idx").on(table.ownerId, table.date),
  check("orders_valid_money", sql`${table.quantity} BETWEEN 1 AND 9999 AND ${table.unitCents} >= 0 AND ${table.extraCents} >= 0 AND ${table.discountCents} >= 0 AND ${table.storeCents} BETWEEN 0 AND 100000000 AND (${table.quantity} * ${table.unitCents} + ${table.extraCents} - ${table.discountCents}) BETWEEN 0 AND 100000000`),
  check("orders_valid_revision", sql`${table.revision} >= 1`),
  check("orders_valid_status", sql`${table.status} IN ('Pendiente', 'Pedido', 'En camino', 'Recibido', 'Entregado', 'Cancelado', 'Cambiado')`),
  check("orders_valid_platform", sql`${table.platform} IN ('Temu', 'SHEIN')`),
]);

export const payments = pgTable("payments", {
  ownerId: text("owner_id").notNull(),
  id: text("id").notNull(),
  orderId: text("order_id").notNull(),
  kind: text("kind").notNull().default("Abono"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  date: text("date").notNull(),
  method: text("method").notNull().default("Efectivo"),
  note: text("note").notNull().default(""),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  foreignKey({ columns: [table.ownerId, table.orderId], foreignColumns: [orders.ownerId, orders.id] }).onDelete("restrict"),
  index("payments_owner_order_idx").on(table.ownerId, table.orderId),
  check("payments_positive_amount", sql`${table.amountCents} > 0 AND ${table.amountCents} <= 100000000`),
  check("payments_valid_kind", sql`${table.kind} IN ('Abono', 'Devolución')`),
]);

export const exchanges = pgTable("exchanges", {
  ownerId: text("owner_id").notNull(),
  id: text("id").notNull(),
  orderId: text("order_id").notNull(),
  date: text("date").notNull(),
  oldArticle: text("old_article").notNull(),
  newArticle: text("new_article").notNull(),
  oldTotalCents: bigint("old_total_cents", { mode: "number" }).notNull(),
  newTotalCents: bigint("new_total_cents", { mode: "number" }).notNull(),
  differenceCents: bigint("difference_cents", { mode: "number" }).notNull(),
  note: text("note").notNull().default(""),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  foreignKey({ columns: [table.ownerId, table.orderId], foreignColumns: [orders.ownerId, orders.id] }).onDelete("restrict"),
  index("exchanges_owner_order_idx").on(table.ownerId, table.orderId),
  check("exchanges_valid_money", sql`${table.oldTotalCents} BETWEEN 0 AND 100000000 AND ${table.newTotalCents} BETWEEN 0 AND 100000000 AND ${table.differenceCents} = ${table.newTotalCents} - ${table.oldTotalCents}`),
]);

export const activities = pgTable("activities", {
  insertionSequence: bigserial("insertion_sequence", { mode: "number" }).notNull(),
  ownerId: text("owner_id").notNull(),
  id: text("id").notNull(),
  at: text("at").notNull(),
  kind: text("kind").notNull(),
  orderId: text("order_id").notNull().default(""),
  client: text("client").notNull().default(""),
  summary: text("summary").notNull(),
  detail: text("detail").notNull().default(""),
}, table => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  index("activities_owner_at_idx").on(table.ownerId, table.at),
]);

export const invoices = pgTable("invoices", {
  ownerId: text("owner_id").notNull(),
  id: text("id").notNull(),
  requestId: text("request_id"),
  sequence: integer("sequence").notNull(),
  number: text("number").notNull(),
  issuedAt: text("issued_at").notNull(),
  client: text("client").notNull(),
  phone: text("phone").notNull().default(""),
  businessName: text("business_name").notNull(),
  notes: text("notes").notNull().default(""),
  pricingMode: text("pricing_mode").notNull().default("items"),
  showAmounts: integer("show_amounts").notNull().default(1),
  registeredTotalCents: bigint("registered_total_cents", { mode: "number" }).notNull().default(0),
  orderIdsJson: text("order_ids_json").notNull(),
  itemsJson: text("items_json").notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  paidCents: bigint("paid_cents", { mode: "number" }).notNull(),
  balanceCents: bigint("balance_cents", { mode: "number" }).notNull(),
}, table => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  uniqueIndex("invoices_owner_sequence_idx").on(table.ownerId, table.sequence),
  uniqueIndex("invoices_owner_number_idx").on(table.ownerId, table.number),
  uniqueIndex("invoices_owner_request_idx").on(table.ownerId, table.requestId),
  index("invoices_owner_issued_idx").on(table.ownerId, table.issuedAt),
  check("invoices_valid_money", sql`${table.totalCents} BETWEEN 0 AND 100000000000 AND ${table.paidCents} BETWEEN 0 AND 100000000000 AND ${table.balanceCents} = ${table.totalCents} - ${table.paidCents}`),
  check("invoices_valid_pricing", sql`${table.pricingMode} IN ('items','manual') AND ${table.showAmounts} IN (0,1) AND ${table.registeredTotalCents} BETWEEN 0 AND 100000000000`),
]);

export const oneDriveConnections = pgTable("onedrive_connections", {
  ownerId: text("owner_id").primaryKey(),
  refreshCipher: text("refresh_cipher").notNull().default(""),
  accessCipher: text("access_cipher").notNull().default(""),
  accessExpiresAt: bigint("access_expires_at", { mode: "number" }).notNull().default(0),
  account: text("account").notNull().default(""),
  driveId: text("drive_id").notNull().default(""),
  fileId: text("file_id").notNull().default(""),
  fileName: text("file_name").notNull().default(""),
  webUrl: text("web_url").notNull().default(""),
  lastModifiedAt: text("last_modified_at").notNull().default(""),
  etag: text("etag").notNull().default(""),
  syncedEtag: text("synced_etag").notNull().default(""),
  downloadedEtag: text("downloaded_etag").notNull().default(""),
  lastSyncAt: text("last_sync_at").notNull().default(""),
  lastSyncError: text("last_sync_error").notNull().default(""),
  revision: integer("revision").notNull().default(1),
});

export const oneDriveOauthStates = pgTable("onedrive_oauth_states", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  verifierCipher: text("verifier_cipher").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
}, table => [index("onedrive_oauth_owner_idx").on(table.ownerId)]);

export const oneDriveBaselines = pgTable("onedrive_baselines", {
  ownerId: text("owner_id").notNull(),
  fileId: text("file_id").notNull(),
  orderId: text("order_id").notNull(),
  remoteHash: text("remote_hash").notNull(),
  localRevision: integer("local_revision").notNull(),
}, table => [primaryKey({ columns: [table.ownerId, table.fileId, table.orderId] })]);

export const oneDriveLedgerBaselines = pgTable("onedrive_ledger_baselines", {
  ownerId: text("owner_id").notNull(),
  fileId: text("file_id").notNull(),
  kind: text("kind").notNull(),
  id: text("id").notNull(),
  fingerprint: text("fingerprint").notNull(),
}, table => [primaryKey({ columns: [table.ownerId, table.fileId, table.kind, table.id] })]);

export const invoiceCounters = pgTable("invoice_counters", {
  ownerId: text("owner_id").primaryKey(),
  nextSequence: integer("next_sequence").notNull().default(1),
});
