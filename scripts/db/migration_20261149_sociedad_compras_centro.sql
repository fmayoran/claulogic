-- La sociedad que recibe las facturas de lo que compra el centro (decisión de Fer, 15/11/2026: siempre CORTAFUEGO, pague la cuenta
-- que pague). CF CENTRAL no tiene CUIT; una factura tiene que ser de una sociedad. Una sola puede tenerlo.
ALTER TABLE org.sociedad ADD COLUMN compras_del_centro boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX sociedad_compras_del_centro_ux ON org.sociedad (compras_del_centro) WHERE compras_del_centro;
UPDATE org.sociedad SET compras_del_centro = true WHERE nombre = 'CORTAFUEGO SRL';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM org.sociedad WHERE compras_del_centro) THEN RAISE EXCEPTION 'No encontré CORTAFUEGO SRL'; END IF;
END $$;
