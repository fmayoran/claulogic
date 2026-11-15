-- La mercadería y los insumos son del centro (decisión de Fer, 15/11/2026).
--
-- Lo que se compra de mercadería e insumos es de CF CENTRAL (la sede central, sin sociedad), pague la cuenta que pague. El costo
-- llega a cada local cuando el centro le traslade la mercadería (remito), no al comprarla. Mientras no haya traslados, esos gastos
-- quedan en "sólo el grupo" del estado de resultados y no restan en el de los locales.
--
-- `fin.rubro.del_centro` marca los rubros así (todos los "Mercadería · …", Mercadería varios, Descartables y packaging, Limpieza y
-- Vajilla y utensilios). Un trigger en fin.clasificacion pone la sede central (y saca el comercio) a todo lo que se clasifica con
-- uno de esos rubros, por regla, a mano o al reclasificar; y las reglas con esos rubros pierden su sede. Las clasificaciones que
-- ya había se pasan a la sede central (respaldo previo en /root/claulogic_respaldos/clasificacion_antes_centro_20261115.sql).

ALTER TABLE fin.rubro ADD COLUMN del_centro boolean NOT NULL DEFAULT false;
UPDATE fin.rubro SET del_centro = true
 WHERE nombre LIKE 'Mercadería%' OR nombre IN ('Descartables y packaging', 'Limpieza', 'Vajilla y utensilios');

CREATE FUNCTION fin.clasificacion_del_centro() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT del_centro FROM fin.rubro WHERE id = NEW.rubro_id) THEN
    NEW.sede_id := (SELECT id FROM org.sede WHERE es_central);
    NEW.comercio_id := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clasificacion_del_centro BEFORE INSERT OR UPDATE ON fin.clasificacion
  FOR EACH ROW EXECUTE FUNCTION fin.clasificacion_del_centro();

-- Lo ya clasificado: el trigger hace el cambio.
UPDATE fin.clasificacion k SET sede_id = k.sede_id
  FROM fin.rubro r WHERE r.id = k.rubro_id AND r.del_centro;

UPDATE fin.regla g SET sede_id = NULL FROM fin.rubro r WHERE r.id = g.rubro_id AND r.del_centro AND g.sede_id IS NOT NULL;
