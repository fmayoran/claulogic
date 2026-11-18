-- Septiembre repartido (decisión de Fer, 18/11/2026): lo vendido va a costo de mercadería ("Mercadería varios", compras sin detalle)
-- y la pérdida de CORTAFUEGO ($16.866.602) a gastos operativos ("Gastos anteriores al sistema"). Los ajustes no se editan: se anulan
-- los de la migración 20261158 con su inverso y se asientan los nuevos. El resultado de septiembre no cambia (−$16.866.602).
INSERT INTO fin.ajuste_resultado (sede_id, dia, rubro_id, importe, concepto)
SELECT sede_id, dia, rubro_id, -importe, 'Anula (se reparte entre mercadería y gastos operativos): ' || concepto
  FROM fin.ajuste_resultado WHERE dia = DATE '2026-09-30' AND rubro_id = (SELECT id FROM fin.rubro WHERE clave = 'previo_sistema') AND importe < 0;

INSERT INTO fin.ajuste_resultado (sede_id, dia, rubro_id, importe, concepto)
SELECT x.sede_id, DATE '2026-09-30', (SELECT id FROM fin.rubro WHERE nombre = 'Mercadería varios' AND linea = 'cmv'), -x.vendido,
       'Costo de mercadería de septiembre sin detalle (anterior al sistema): igual a lo vendido'
  FROM (SELECT r.sede_id, SUM(r.importe) AS vendido FROM fin.resultado r JOIN fin.rubro ru ON ru.id = r.rubro_id
         WHERE ru.clave = 'ventas' AND r.dia BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY r.sede_id) x
  JOIN org.sede s ON s.id = x.sede_id
 WHERE s.nombre IN ('CORTAFUEGO PARRILLA', 'SORELLE BODEGON Y SUSHI', 'SORELLE CAFETERIA');

INSERT INTO fin.ajuste_resultado (sede_id, dia, rubro_id, importe, concepto)
SELECT s.id, DATE '2026-09-30', (SELECT id FROM fin.rubro WHERE clave = 'previo_sistema'), -16866602,
       'Gastos operativos de septiembre sin detalle: la pérdida de $16.866.602 cubierta con un aporte de los socios'
  FROM org.sede s WHERE s.nombre = 'CORTAFUEGO PARRILLA';
