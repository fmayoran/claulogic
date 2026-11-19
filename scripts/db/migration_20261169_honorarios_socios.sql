-- Honorarios de los socios (Fer, 19/11/2026): los de Adrián Sandoval son "Sueldos · Honorarios socios" (línea Personal), no honorarios
-- profesionales. Octubre: $5.000.000 en total, pagados con la transferencia de PAGO 24 del 13/10 ($2.500.000) y el resto en efectivo
-- desde CAJA MAYOR (el pago de Fudo #1526 del 05/10, $2.500.000). Los dos ya estaban registrados: sólo cambian de rubro, en
-- CORTAFUEGO PARRILLA. El resultado de octubre no cambia; pasa de Administración a Personal. Noviembre, sin tocar.
INSERT INTO fin.rubro (nombre, linea, activo, del_centro, orden)
SELECT 'Sueldos · Honorarios socios', 'personal', true, false, (SELECT COALESCE(MAX(orden), 100) FROM fin.rubro WHERE linea = 'personal') + 1
 WHERE NOT EXISTS (SELECT 1 FROM fin.rubro WHERE nombre = 'Sueldos · Honorarios socios');

UPDATE fin.clasificacion
   SET rubro_id = (SELECT id FROM fin.rubro WHERE nombre = 'Sueldos · Honorarios socios'),
       sede_id = (SELECT id FROM org.sede WHERE nombre = 'CORTAFUEGO PARRILLA')
 WHERE movimiento_id IN (25913, 27971);

DO $$
BEGIN
  IF (SELECT SUM(m.salida) FROM fin.movimiento_tes m JOIN fin.clasificacion k ON k.movimiento_id = m.id JOIN fin.rubro r ON r.id = k.rubro_id
       WHERE r.nombre = 'Sueldos · Honorarios socios' AND m.fecha BETWEEN DATE '2026-10-01' AND DATE '2026-10-31') <> 5000000 THEN
    RAISE EXCEPTION 'Los honorarios de socios de octubre no suman 5.000.000';
  END IF;
END $$;
