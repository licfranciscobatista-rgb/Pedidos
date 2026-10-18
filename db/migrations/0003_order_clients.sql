ALTER TABLE orders ADD COLUMN client_id text;
ALTER TABLE orders ADD CONSTRAINT orders_client_fk FOREIGN KEY(owner_id,client_id) REFERENCES clients(owner_id,id) ON DELETE RESTRICT;
CREATE INDEX orders_owner_client_idx ON orders(owner_id,client_id);
-- Text-only historical orders are linked only when exactly one client matches.
-- Invoice snapshots remain untouched.
WITH matches AS (
 SELECT o.owner_id,o.id,MIN(c.id) AS client_id FROM orders o JOIN clients c ON c.owner_id=o.owner_id AND lower(trim(c.name))=lower(trim(o.client)) AND regexp_replace(c.phone,'[^0-9]','','g')=regexp_replace(o.phone,'[^0-9]','','g')
 GROUP BY o.owner_id,o.id HAVING COUNT(*)=1
)
UPDATE orders o SET client_id=m.client_id FROM matches m WHERE o.owner_id=m.owner_id AND o.id=m.id AND o.client_id IS NULL;
