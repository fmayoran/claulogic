-- Limpieza deliberada de los datos de prueba del proceso de ingresos (pedido de Fer, 03/11/2026).
--
-- Por qué: Fer va a correr octubre entero a mano desde la aplicación, paso por paso, para asegurar el proceso e ir ajustando la
-- app; noviembre recién cuando octubre esté cerrado. Lo que había (ventas de octubre y del 01-02/11, cobros, rendiciones de
-- efectivo, extractos de Mercado Pago SORELLE y Pago24 con sus conciliaciones, lotes de Fudo Pagos) eran pruebas, varias con
-- errores ya corregidos (la corrida automática de Pago24 del 03/11). Anularlas habría dejado ~5.700 movimientos más que ensucian
-- la prueba. Respaldo previo: /root/claulogic_respaldos/antes_limpieza_ingresos_20261103.dump (pg_dump -Fc de toda la base).
--
-- Qué se vacía: ventas importadas (tickets, renglones, pagos, importaciones, consumo, cobros, corridas, días sincronizados),
-- tesorería (movimientos, arqueos, clasificaciones), extractos y sus líneas, conciliaciones, lotes y corridas del portal.
-- Qué queda: sedes, integraciones y credenciales, artículos y medios asignados, medios de pago, procesadores, cuentas, rubros,
-- usuarios, y todo el esquema logic (stock, compras, productos).
--
-- El libro mayor de tesorería no se borra: lo frenan sus triggers. No alcanza con un TRUNCATE (logic.movimiento referencia a
-- pos.consumo, vacía, y el TRUNCATE no se puede sin vaciar también el stock), así que se borra con DELETE en orden, con los
-- triggers propios de estas tablas desactivados sólo dentro de esta migración (el corredor la aplica en una transacción) y
-- vueltos a activar al final. Las claves foráneas siguen activas.
ALTER TABLE fin.movimiento_tes DISABLE TRIGGER USER;
ALTER TABLE fin.conciliacion DISABLE TRIGGER USER;

-- Ciclo de claves: movimiento_tes -> ticket_pago -> lote -> movimiento_tes. Se corta soltando los pagos de lotes y extractos.
UPDATE pos.ticket_pago SET lote_id = NULL, acreditado_linea_id = NULL WHERE lote_id IS NOT NULL OR acreditado_linea_id IS NOT NULL;
DELETE FROM fin.conciliacion;
DELETE FROM fin.clasificacion;
DELETE FROM fin.arqueo;
DELETE FROM fin.lote;
DELETE FROM fin.movimiento_tes;
DELETE FROM pos.ticket_pago;
DELETE FROM pos.ticket_item;
DELETE FROM pos.ticket;
DELETE FROM fin.extracto_linea;
DELETE FROM fin.extracto;
DELETE FROM pos.consumo;
DELETE FROM pos.cobro;
DELETE FROM pos.importacion;
DELETE FROM pos.corrida;
DELETE FROM pos.sincronizacion_dia;
DELETE FROM fin.portal_corrida;

ALTER TABLE fin.movimiento_tes ENABLE TRIGGER USER;
ALTER TABLE fin.conciliacion ENABLE TRIGGER USER;
