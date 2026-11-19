-- Situación al 01/10/2026 de CORTAFUEGO (decisión de Fer, 19/11/2026). Los socios pusieron la plata de la pérdida de septiembre
-- ($16.866.602) y la que quedó en las cuentas de CORTAFUEGO al 30/09 (los saldos de apertura de sus extractos): todo es deuda con
-- ellos, en PRÉSTAMOS DE SOCIOS. Por única vez; en la operación normal un gasto que paga un socio es un egreso de esa cuenta.
--
-- 1. La pérdida deja de ser un ajuste sin plata (migración 20261159): se anula con su inverso y se asienta como un gasto pagado por
--    los socios, egreso de PRÉSTAMOS DE SOCIOS del 30/09 clasificado en "Gastos anteriores al sistema" de CORTAFUEGO PARRILLA.
--    El resultado de septiembre no cambia.
-- 2. Los saldos de apertura de BRUBANK, MERCADO PAGO CF y PAGO 24 dejan de ser plata sin origen: se anulan (con fecha 30/09, para no
--    mover los saldos de octubre y noviembre) y se asientan como transferencias de PRÉSTAMOS DE SOCIOS a cada cuenta, el 30/09, con
--    el mismo concepto de apertura (así siguen fuera del flujo de caja y de lo que falta conciliar).
-- PRÉSTAMOS DE SOCIOS queda al 30/09 en −$19.706.719,08 (lo que se les debe). MERCADO PAGO SORELLE, aparte.

INSERT INTO fin.ajuste_resultado (sede_id, dia, rubro_id, importe, concepto)
SELECT sede_id, dia, rubro_id, -importe, 'Anula (pasa a gasto pagado por los socios, egreso de PRÉSTAMOS DE SOCIOS): ' || concepto
  FROM fin.ajuste_resultado
 WHERE dia = DATE '2026-09-30' AND rubro_id = (SELECT id FROM fin.rubro WHERE clave = 'previo_sistema') AND importe = -16866602;

WITH m AS (
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto)
  SELECT DATE '2026-09-30', id, 'egreso', 0, 16866602,
         'Gastos de septiembre sin detalle, pagados por los socios (la pérdida anterior al sistema)'
    FROM fin.cuenta WHERE tipo = 'socios'
  RETURNING id)
INSERT INTO fin.clasificacion (movimiento_id, rubro_id, sede_id)
SELECT m.id, (SELECT id FROM fin.rubro WHERE clave = 'previo_sistema'), (SELECT id FROM org.sede WHERE nombre = 'CORTAFUEGO PARRILLA')
  FROM m;

INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, anula_a)
SELECT m.fecha, m.cuenta_id, 'anulacion', m.salida, m.entrada, 'Anula (pasa a préstamo de los socios): ' || m.concepto, m.id
  FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id
 WHERE m.concepto = 'Saldo de apertura según extracto' AND m.tipo = 'ingreso' AND m.fecha = DATE '2026-09-30'
   AND c.nombre IN ('BRUBANK', 'MERCADO PAGO CF', 'PAGO 24 - 210973')
   AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id);

SELECT fin.transferir((SELECT id FROM fin.cuenta WHERE tipo = 'socios'), c.id, x.importe, DATE '2026-09-30', 'Saldo de apertura según extracto')
  FROM (VALUES ('BRUBANK', 559302.67), ('MERCADO PAGO CF', 518132.29), ('PAGO 24 - 210973', 1762682.12)) x(cuenta, importe)
  JOIN fin.cuenta c ON c.nombre = x.cuenta;

DO $$
DECLARE s numeric;
BEGIN
  SELECT SUM(m.entrada - m.salida) INTO s FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id
   WHERE c.tipo = 'socios' AND m.fecha <= DATE '2026-09-30';
  IF s IS DISTINCT FROM -19706719.08 THEN RAISE EXCEPTION 'PRÉSTAMOS DE SOCIOS al 30/09 da % y tenía que dar -19706719.08', s; END IF;
END $$;
