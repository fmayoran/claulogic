-- Préstamos de socios (decisión de Fer, 11/11/2026). Los saldos de los gastos que en Fudo quedaron "a pagar" los pagaron los
-- socios con plata propia: hay que contarlos como gasto y llevar lo que se les debe. Una cuenta de tipo nuevo, 'socios', que
-- no suma al disponible: un gasto que pagó un socio sale de ahí (egreso con su rubro) y su saldo negativo es la deuda con los
-- socios; devolverles es una transferencia del banco a esta cuenta. Por ahora una sola cuenta global, no una por socio.
ALTER TABLE fin.cuenta DROP CONSTRAINT cuenta_tipo_check;
ALTER TABLE fin.cuenta ADD CONSTRAINT cuenta_tipo_check CHECK (tipo IN ('banco','caja','cartera','cobranza','socios'));

INSERT INTO fin.cuenta (nombre, tipo, sede_id)
SELECT 'PRÉSTAMOS DE SOCIOS', 'socios', id FROM org.sede WHERE es_central;
