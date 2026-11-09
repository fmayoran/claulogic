-- Rendimientos de Mercado Pago (pedido de Fer, 09/11/2026): "Rendimiento dinero en cuenta" es el interés que paga MP por el saldo.
-- Rubro del sistema "Otros ingresos financieros" (línea Otros) y una regla para cualquier cuenta: la conciliación automática lo
-- asienta, lo clasifica y lo concilia solo.
INSERT INTO fin.rubro (nombre, linea, clave, orden)
VALUES ('Otros ingresos financieros', 'otros', 'ingreso_financiero', 100)
ON CONFLICT DO NOTHING;

INSERT INTO fin.regla (cuenta_id, sentido, patron, rubro_id)
SELECT NULL, 'ingreso', 'Rendimiento dinero en cuenta', id FROM fin.rubro WHERE clave = 'ingreso_financiero'
 AND NOT EXISTS (SELECT 1 FROM fin.regla WHERE cuenta_id IS NULL AND sentido = 'ingreso' AND lower(patron) = 'rendimiento dinero en cuenta');
