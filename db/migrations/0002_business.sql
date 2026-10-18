CREATE TABLE clients (
 owner_id text NOT NULL, id text NOT NULL, name text NOT NULL, phone text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), created_at text NOT NULL, updated_at text NOT NULL,
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX clients_owner_name_idx ON clients(owner_id,name);
CREATE TABLE quotes (
 owner_id text NOT NULL, id text NOT NULL, client_id text NOT NULL, date text NOT NULL, valid_until text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'Borrador' CHECK(status IN ('Borrador','Enviada','Aceptada','Rechazada','Vencida')), notes text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), total_cents bigint NOT NULL CHECK(total_cents BETWEEN 0 AND 100000000), created_at text NOT NULL, updated_at text NOT NULL,
 PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id,client_id) REFERENCES clients(owner_id,id) ON DELETE RESTRICT
);
CREATE INDEX quotes_owner_date_idx ON quotes(owner_id,date);
CREATE TABLE quote_items (
 owner_id text NOT NULL, quote_id text NOT NULL, id text NOT NULL, position integer NOT NULL CHECK(position>=0), article text NOT NULL, variant text NOT NULL DEFAULT '', platform text NOT NULL CHECK(platform IN ('Temu','SHEIN')), quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 9999), unit_cents bigint NOT NULL CHECK(unit_cents BETWEEN 0 AND 100000000), extra_cents bigint NOT NULL DEFAULT 0 CHECK(extra_cents BETWEEN 0 AND 100000000), discount_cents bigint NOT NULL DEFAULT 0 CHECK(discount_cents BETWEEN 0 AND 100000000),
 PRIMARY KEY(owner_id,quote_id,id), FOREIGN KEY(owner_id,quote_id) REFERENCES quotes(owner_id,id) ON DELETE RESTRICT,
 CHECK(quantity*unit_cents+extra_cents-discount_cents BETWEEN 0 AND 100000000)
);
CREATE TABLE invoice_drafts (
 owner_id text NOT NULL, id text NOT NULL, client_id text NOT NULL, date text NOT NULL, business_name text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', pricing_mode text NOT NULL DEFAULT 'items' CHECK(pricing_mode IN ('items','manual')), manual_total_cents bigint NOT NULL DEFAULT 0 CHECK(manual_total_cents BETWEEN 0 AND 100000000), show_amounts boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), issued_invoice_id text, created_at text NOT NULL, updated_at text NOT NULL,
 PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id,client_id) REFERENCES clients(owner_id,id) ON DELETE RESTRICT, FOREIGN KEY(owner_id,issued_invoice_id) REFERENCES invoices(owner_id,id) ON DELETE RESTRICT
);
CREATE INDEX invoice_drafts_owner_date_idx ON invoice_drafts(owner_id,date);
CREATE TABLE invoice_draft_items (
 owner_id text NOT NULL, draft_id text NOT NULL, order_id text NOT NULL, position integer NOT NULL CHECK(position>=0), delivery_label text NOT NULL DEFAULT 'Por confirmar' CHECK(delivery_label IN ('Llega en esta entrega','Sigue pendiente','Ya entregado','Por confirmar')),
 PRIMARY KEY(owner_id,draft_id,order_id), FOREIGN KEY(owner_id,draft_id) REFERENCES invoice_drafts(owner_id,id) ON DELETE RESTRICT, FOREIGN KEY(owner_id,order_id) REFERENCES orders(owner_id,id) ON DELETE RESTRICT
);
ALTER TABLE invoices ADD COLUMN source_draft_id text;
CREATE UNIQUE INDEX invoices_owner_source_draft_idx ON invoices(owner_id,source_draft_id);
ALTER TABLE invoices ADD CONSTRAINT invoices_source_draft_fk FOREIGN KEY(owner_id,source_draft_id) REFERENCES invoice_drafts(owner_id,id) ON DELETE RESTRICT;
CREATE TABLE business_baselines (
 owner_id text NOT NULL, file_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('clients','quotes','invoiceDrafts')), id text NOT NULL, fingerprint text NOT NULL, local_revision integer NOT NULL CHECK(local_revision>=1), PRIMARY KEY(owner_id,file_id,kind,id)
);
