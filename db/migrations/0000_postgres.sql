CREATE TABLE "activities" (
	"insertion_sequence" bigserial NOT NULL,
	"owner_id" text NOT NULL,
	"id" text NOT NULL,
	"at" text NOT NULL,
	"kind" text NOT NULL,
	"order_id" text DEFAULT '' NOT NULL,
	"client" text DEFAULT '' NOT NULL,
	"summary" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	CONSTRAINT "activities_owner_id_id_pk" PRIMARY KEY("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "exchanges" (
	"owner_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"date" text NOT NULL,
	"old_article" text NOT NULL,
	"new_article" text NOT NULL,
	"old_total_cents" bigint NOT NULL,
	"new_total_cents" bigint NOT NULL,
	"difference_cents" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "exchanges_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "exchanges_valid_money" CHECK ("exchanges"."old_total_cents" BETWEEN 0 AND 100000000 AND "exchanges"."new_total_cents" BETWEEN 0 AND 100000000 AND "exchanges"."difference_cents" = "exchanges"."new_total_cents" - "exchanges"."old_total_cents")
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"owner_id" text NOT NULL,
	"id" text NOT NULL,
	"request_id" text,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"issued_at" text NOT NULL,
	"client" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"business_name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"pricing_mode" text DEFAULT 'items' NOT NULL,
	"show_amounts" integer DEFAULT 1 NOT NULL,
	"registered_total_cents" bigint DEFAULT 0 NOT NULL,
	"order_ids_json" text NOT NULL,
	"items_json" text NOT NULL,
	"total_cents" bigint NOT NULL,
	"paid_cents" bigint NOT NULL,
	"balance_cents" bigint NOT NULL,
	CONSTRAINT "invoices_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "invoices_valid_money" CHECK ("invoices"."total_cents" BETWEEN 0 AND 100000000000 AND "invoices"."paid_cents" BETWEEN 0 AND 100000000000 AND "invoices"."balance_cents" = "invoices"."total_cents" - "invoices"."paid_cents"),
	CONSTRAINT "invoices_valid_pricing" CHECK ("invoices"."pricing_mode" IN ('items','manual') AND "invoices"."show_amounts" IN (0,1) AND "invoices"."registered_total_cents" BETWEEN 0 AND 100000000000)
);
--> statement-breakpoint
CREATE TABLE "onedrive_baselines" (
	"owner_id" text NOT NULL,
	"file_id" text NOT NULL,
	"order_id" text NOT NULL,
	"remote_hash" text NOT NULL,
	"local_revision" integer NOT NULL,
	CONSTRAINT "onedrive_baselines_owner_id_file_id_order_id_pk" PRIMARY KEY("owner_id","file_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "onedrive_connections" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"refresh_cipher" text DEFAULT '' NOT NULL,
	"access_cipher" text DEFAULT '' NOT NULL,
	"access_expires_at" bigint DEFAULT 0 NOT NULL,
	"account" text DEFAULT '' NOT NULL,
	"drive_id" text DEFAULT '' NOT NULL,
	"file_id" text DEFAULT '' NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"web_url" text DEFAULT '' NOT NULL,
	"last_modified_at" text DEFAULT '' NOT NULL,
	"etag" text DEFAULT '' NOT NULL,
	"synced_etag" text DEFAULT '' NOT NULL,
	"downloaded_etag" text DEFAULT '' NOT NULL,
	"last_sync_at" text DEFAULT '' NOT NULL,
	"last_sync_error" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onedrive_ledger_baselines" (
	"owner_id" text NOT NULL,
	"file_id" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "onedrive_ledger_baselines_owner_id_file_id_kind_id_pk" PRIMARY KEY("owner_id","file_id","kind","id")
);
--> statement-breakpoint
CREATE TABLE "onedrive_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"verifier_cipher" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"owner_id" text NOT NULL,
	"id" text NOT NULL,
	"platform" text DEFAULT 'Temu' NOT NULL,
	"client" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"batch" text DEFAULT '' NOT NULL,
	"article" text NOT NULL,
	"variant" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cents" bigint NOT NULL,
	"extra_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"store_cents" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'Pendiente' NOT NULL,
	"date" text NOT NULL,
	"delivery_date" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"photo_key" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "orders_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "orders_valid_money" CHECK ("orders"."quantity" BETWEEN 1 AND 9999 AND "orders"."unit_cents" >= 0 AND "orders"."extra_cents" >= 0 AND "orders"."discount_cents" >= 0 AND "orders"."store_cents" BETWEEN 0 AND 100000000 AND ("orders"."quantity" * "orders"."unit_cents" + "orders"."extra_cents" - "orders"."discount_cents") BETWEEN 0 AND 100000000),
	CONSTRAINT "orders_valid_revision" CHECK ("orders"."revision" >= 1),
	CONSTRAINT "orders_valid_status" CHECK ("orders"."status" IN ('Pendiente', 'Pedido', 'En camino', 'Recibido', 'Entregado', 'Cancelado', 'Cambiado')),
	CONSTRAINT "orders_valid_platform" CHECK ("orders"."platform" IN ('Temu', 'SHEIN'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"owner_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"kind" text DEFAULT 'Abono' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" text NOT NULL,
	"method" text DEFAULT 'Efectivo' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "payments_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "payments_positive_amount" CHECK ("payments"."amount_cents" > 0 AND "payments"."amount_cents" <= 100000000),
	CONSTRAINT "payments_valid_kind" CHECK ("payments"."kind" IN ('Abono', 'Devolución'))
);
--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_owner_id_order_id_orders_owner_id_id_fk" FOREIGN KEY ("owner_id","order_id") REFERENCES "orders"("owner_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_owner_id_order_id_orders_owner_id_id_fk" FOREIGN KEY ("owner_id","order_id") REFERENCES "orders"("owner_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_owner_at_idx" ON "activities" USING btree ("owner_id","at");--> statement-breakpoint
CREATE INDEX "exchanges_owner_order_idx" ON "exchanges" USING btree ("owner_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_owner_sequence_idx" ON "invoices" USING btree ("owner_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_owner_number_idx" ON "invoices" USING btree ("owner_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_owner_request_idx" ON "invoices" USING btree ("owner_id","request_id");--> statement-breakpoint
CREATE INDEX "invoices_owner_issued_idx" ON "invoices" USING btree ("owner_id","issued_at");--> statement-breakpoint
CREATE INDEX "onedrive_oauth_owner_idx" ON "onedrive_oauth_states" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "orders_owner_date_idx" ON "orders" USING btree ("owner_id","date");--> statement-breakpoint
CREATE INDEX "payments_owner_order_idx" ON "payments" USING btree ("owner_id","order_id");
