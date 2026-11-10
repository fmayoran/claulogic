-- Préstamos de socios en BRUBANK (CORTAFUEGO), decisión de Fer, 10/11/2026.
-- Ocho ingresos del extracto que no venían de ventas (Fernando Mayorano, ABUNDEMIO CASH, DESARROLLOS VILARA, VILLATECNO,
-- SEMILLAS DEL CAMPO, JONATHAN LEDESMA) son préstamos de socios: se registran como ingreso de BRUBANK, rubro "Aportes, retiros y
-- préstamos" (no es resultado), y se concilian con su línea. Lo mismo que hace "Registrar movimiento" desde la conciliación.
-- Sólo las líneas que siguen pendientes y con el importe esperado: si alguna ya se resolvió a mano, se saltea.
DO $$
DECLARE
  x record; m bigint; n int := 0;
  rub uuid := (SELECT id FROM fin.rubro WHERE clave = 'fuera');
BEGIN
  PERFORM set_config('logic.usuario', 'fer', true);
  FOR x IN
    SELECT l.id, l.fecha, l.importe, l.cuenta_id, l.concepto
      FROM fin.extracto_linea l JOIN fin.cuenta c ON c.id = l.cuenta_id
      JOIN (VALUES (19934, 1000000.00), (19937, 1000000.00), (19943, 700000.00), (19991, 800000.00),
                   (20049, 80000.00), (20279, 2000000.00), (20280, 5000000.00), (20307, 800000.00)) v(id, imp)
        ON v.id = l.id AND v.imp = l.importe
     WHERE c.nombre = 'BRUBANK' AND l.compensa_a IS NULL AND l.descartada IS NULL
       AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)
  LOOP
    INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto)
    VALUES (x.fecha, x.cuenta_id, 'ingreso', x.importe, 'Préstamo de socios · ' || x.concepto) RETURNING id INTO m;
    INSERT INTO fin.clasificacion (movimiento_id, rubro_id, por) VALUES (m, rub, 'fer');
    INSERT INTO fin.conciliacion (linea_id, movimiento_id) VALUES (x.id, m);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'Préstamos de socios registrados: %', n;
END $$;
