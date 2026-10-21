-- Fase 3: tesorería. Cuentas (bancos, cajas por sede, cartera de cheques), órdenes de pago con
-- aplicación a comprobantes y retenciones, cheques propios y de terceros, arqueo de caja y
-- conciliación bancaria.
--
-- Misma decisión de fondo que el stock y la cuenta corriente: EL SALDO DE UNA CUENTA NO SE GUARDA,
-- SE DERIVA de `fin.movimiento_tes`, un libro mayor inmutable. Para corregir se asienta el
-- movimiento inverso, y quedan los dos.

-- ── Cuentas ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE fin.cuenta (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  tipo       text NOT NULL CHECK (tipo IN ('banco','caja','cartera')),
  sede_id    uuid REFERENCES org.sede(id),           -- la caja es de una sede
  banco      text,
  numero     text,
  cbu        text CHECK (cbu IS NULL OR cbu ~ '^\d{22}$'),
  alias      text,
  activa     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  CHECK (tipo <> 'caja' OR sede_id IS NOT NULL)
);
CREATE UNIQUE INDEX cuenta_nombre_ux ON fin.cuenta (lower(btrim(nombre)));
-- Una sola cartera de cheques de terceros: es donde están los cheques recibidos hasta que se
-- endosan o se depositan.
CREATE UNIQUE INDEX cuenta_cartera_ux ON fin.cuenta (tipo) WHERE tipo = 'cartera';
INSERT INTO fin.cuenta (nombre, tipo) VALUES ('Cartera de cheques de terceros', 'cartera');

-- ── Libro mayor de tesorería ─────────────────────────────────────────────────────────────────
CREATE TABLE fin.movimiento_tes (
  id                bigserial PRIMARY KEY,
  ocurrido_en       timestamptz NOT NULL DEFAULT now(),
  fecha             date NOT NULL,
  cuenta_id         uuid NOT NULL REFERENCES fin.cuenta(id),
  tipo              text NOT NULL CHECK (tipo IN ('pago','transferencia','ingreso','egreso','arqueo',
                                                  'alta_cheque','endoso','deposito_cheque','debito_cheque','anulacion')),
  entrada           numeric(16,2) NOT NULL DEFAULT 0 CHECK (entrada >= 0),
  salida            numeric(16,2) NOT NULL DEFAULT 0 CHECK (salida >= 0),
  concepto          text,
  orden_pago_id     uuid,                 -- la FK se agrega abajo, cuando existe la tabla
  cheque_id         uuid,
  transferencia_id  uuid,                 -- las dos patas de una transferencia entre cuentas
  anula_a           bigint REFERENCES fin.movimiento_tes(id),
  registrado_por    text DEFAULT org.usuario_actual(),
  CHECK ((entrada > 0) <> (salida > 0))
);
CREATE INDEX movimiento_tes_cuenta_ix ON fin.movimiento_tes (cuenta_id, fecha, id);
CREATE UNIQUE INDEX movimiento_tes_anula_ux ON fin.movimiento_tes (anula_a) WHERE anula_a IS NOT NULL;
CREATE TRIGGER movimiento_tes_sin_update BEFORE UPDATE OR DELETE ON fin.movimiento_tes
  FOR EACH ROW EXECUTE FUNCTION logic.inmutable();
CREATE TRIGGER movimiento_tes_sin_truncate BEFORE TRUNCATE ON fin.movimiento_tes
  FOR EACH STATEMENT EXECUTE FUNCTION logic.inmutable();

-- Toda plata que entra o sale pasa por acá, venga de donde venga: se exige permiso de finanzas y
-- una cuenta activa, y la firma la pone la base.
CREATE OR REPLACE FUNCTION fin.movimiento_tes_firma() RETURNS trigger AS $$
BEGIN
  PERFORM org.exigir_finanzas();
  IF NOT (SELECT activa FROM fin.cuenta WHERE id = NEW.cuenta_id) AND NEW.anula_a IS NULL THEN
    RAISE EXCEPTION 'La cuenta está inactiva.';
  END IF;
  NEW.registrado_por := COALESCE(org.usuario_actual(), NEW.registrado_por);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movimiento_tes_firma BEFORE INSERT ON fin.movimiento_tes
  FOR EACH ROW EXECUTE FUNCTION fin.movimiento_tes_firma();

CREATE VIEW fin.saldo_cuenta AS
SELECT c.id AS cuenta_id, COALESCE(SUM(m.entrada - m.salida), 0) AS saldo, MAX(m.fecha) AS ultimo_movimiento
  FROM fin.cuenta c LEFT JOIN fin.movimiento_tes m ON m.cuenta_id = c.id
 GROUP BY c.id;

-- ── Cheques ──────────────────────────────────────────────────────────────────────────────────
-- Propio: emitido (entregado, la deuda ya se canceló) -> debitado (salió del banco) | anulado.
-- De tercero: en cartera -> endosado (a un proveedor) | depositado (entró al banco) | anulado.
CREATE TABLE fin.cheque (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo             text NOT NULL CHECK (tipo IN ('propio','tercero')),
  formato          text NOT NULL DEFAULT 'fisico' CHECK (formato IN ('fisico','echeq')),
  banco            text NOT NULL CHECK (btrim(banco) <> ''),
  numero           text NOT NULL CHECK (btrim(numero) <> ''),
  librador         text,
  cuit_librador    text CHECK (cuit_librador IS NULL OR fin.cuit_valido(cuit_librador)),
  importe          numeric(16,2) NOT NULL CHECK (importe > 0),
  fecha_emision    date,
  fecha_pago       date NOT NULL,
  cuenta_id        uuid REFERENCES fin.cuenta(id),     -- propio: el banco que lo paga; tercero depositado: dónde
  estado           text NOT NULL CHECK (estado IN ('emitido','debitado','en_cartera','endosado','depositado','anulado')),
  proveedor_id     uuid REFERENCES logic.proveedor(id), -- a quién se entregó
  orden_pago_id    uuid,
  recibido_de      text,                                -- tercero: de quién se recibió
  notas            text,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  CHECK (tipo <> 'propio' OR (cuenta_id IS NOT NULL AND estado IN ('emitido','debitado','anulado'))),
  CHECK (tipo <> 'tercero' OR estado IN ('en_cartera','endosado','depositado','anulado'))
);
-- El mismo cheque no se carga dos veces (salvo uno anulado, que se puede volver a emitir).
CREATE UNIQUE INDEX cheque_ux ON fin.cheque (tipo, lower(btrim(banco)), btrim(numero), COALESCE(cuit_librador, ''))
  WHERE estado <> 'anulado';
CREATE INDEX cheque_estado_ix ON fin.cheque (tipo, estado, fecha_pago);

ALTER TABLE fin.movimiento_tes ADD CONSTRAINT movimiento_tes_cheque_fk FOREIGN KEY (cheque_id) REFERENCES fin.cheque(id);

CREATE OR REPLACE FUNCTION fin.cartera() RETURNS uuid AS $$
  SELECT id FROM fin.cuenta WHERE tipo = 'cartera'
$$ LANGUAGE sql STABLE;

-- Un cheque de tercero recibido entra a la cartera.
CREATE OR REPLACE FUNCTION fin.ingresar_cheque(p_formato text, p_banco text, p_numero text, p_librador text,
  p_cuit text, p_importe numeric, p_emision date, p_pago date, p_recibido_de text, p_notas text) RETURNS uuid AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM org.exigir_finanzas();
  INSERT INTO fin.cheque (tipo, formato, banco, numero, librador, cuit_librador, importe, fecha_emision, fecha_pago,
                          estado, recibido_de, notas)
  VALUES ('tercero', p_formato, p_banco, p_numero, p_librador, NULLIF(regexp_replace(COALESCE(p_cuit, ''), '\D', '', 'g'), ''),
          p_importe, p_emision, p_pago, 'en_cartera', p_recibido_de, p_notas)
  RETURNING id INTO v_id;
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, cheque_id)
  VALUES (COALESCE(p_emision, current_date), fin.cartera(), 'alta_cheque', p_importe,
          'Cheque ' || p_banco || ' Nº ' || p_numero || COALESCE(' de ' || p_recibido_de, ''), v_id);
  RETURN v_id;
END $$ LANGUAGE plpgsql;

-- Un cheque de tercero en cartera se deposita en un banco propio.
CREATE OR REPLACE FUNCTION fin.depositar_cheque(p_cheque uuid, p_cuenta uuid, p_fecha date) RETURNS void AS $$
DECLARE ch record;
BEGIN
  PERFORM org.exigir_finanzas();
  SELECT * INTO ch FROM fin.cheque WHERE id = p_cheque FOR UPDATE;
  IF ch.tipo IS DISTINCT FROM 'tercero' OR ch.estado <> 'en_cartera' THEN
    RAISE EXCEPTION 'Sólo se deposita un cheque de tercero que esté en cartera.';
  END IF;
  IF (SELECT tipo FROM fin.cuenta WHERE id = p_cuenta) IS DISTINCT FROM 'banco' THEN
    RAISE EXCEPTION 'Un cheque se deposita en una cuenta bancaria.';
  END IF;
  UPDATE fin.cheque SET estado = 'depositado', cuenta_id = p_cuenta WHERE id = p_cheque;
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, cheque_id)
  VALUES (p_fecha, fin.cartera(), 'deposito_cheque', ch.importe, 'Depósito cheque ' || ch.banco || ' Nº ' || ch.numero, p_cheque);
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, cheque_id)
  VALUES (p_fecha, p_cuenta, 'deposito_cheque', ch.importe, 'Depósito cheque ' || ch.banco || ' Nº ' || ch.numero, p_cheque);
END $$ LANGUAGE plpgsql;

-- Un cheque propio emitido se debita: recién ahí sale la plata del banco. Devuelve el movimiento
-- (la conciliación lo enlaza con la línea del extracto).
CREATE OR REPLACE FUNCTION fin.debitar_cheque(p_cheque uuid, p_fecha date) RETURNS bigint AS $$
DECLARE ch record; v_mov bigint;
BEGIN
  PERFORM org.exigir_finanzas();
  SELECT * INTO ch FROM fin.cheque WHERE id = p_cheque FOR UPDATE;
  IF ch.tipo IS DISTINCT FROM 'propio' OR ch.estado <> 'emitido' THEN
    RAISE EXCEPTION 'Sólo se debita un cheque propio emitido.';
  END IF;
  UPDATE fin.cheque SET estado = 'debitado' WHERE id = p_cheque;
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, cheque_id, orden_pago_id)
  VALUES (p_fecha, ch.cuenta_id, 'debito_cheque', ch.importe, 'Débito cheque Nº ' || ch.numero, p_cheque, ch.orden_pago_id)
  RETURNING id INTO v_mov;
  RETURN v_mov;
END $$ LANGUAGE plpgsql;

-- ── Transferencias, movimientos manuales y arqueo ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fin.transferir(p_origen uuid, p_destino uuid, p_importe numeric, p_fecha date, p_concepto text)
RETURNS uuid AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_origen = p_destino THEN RAISE EXCEPTION 'El origen y el destino son la misma cuenta.'; END IF;
  IF 'cartera' IN ((SELECT tipo FROM fin.cuenta WHERE id = p_origen), (SELECT tipo FROM fin.cuenta WHERE id = p_destino)) THEN
    RAISE EXCEPTION 'La cartera de cheques no se mueve por transferencia: se endosa o se deposita cada cheque.';
  END IF;
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, transferencia_id)
  VALUES (p_fecha, p_origen, 'transferencia', p_importe, p_concepto, v_id);
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, transferencia_id)
  VALUES (p_fecha, p_destino, 'transferencia', p_importe, p_concepto, v_id);
  RETURN v_id;
END $$ LANGUAGE plpgsql;

-- Arqueo de caja: se cuenta lo que hay y la base asienta la diferencia, igual que un conteo de
-- stock. El arqueo queda registrado aunque cierre.
CREATE TABLE fin.arqueo (
  id             bigserial PRIMARY KEY,
  ocurrido_en    timestamptz NOT NULL DEFAULT now(),
  cuenta_id      uuid NOT NULL REFERENCES fin.cuenta(id),
  sistema        numeric(16,2) NOT NULL,
  contado        numeric(16,2) NOT NULL CHECK (contado >= 0),
  diferencia     numeric(16,2) GENERATED ALWAYS AS (contado - sistema) STORED,
  movimiento_id  bigint REFERENCES fin.movimiento_tes(id),
  motivo         text NOT NULL CHECK (btrim(motivo) <> ''),
  registrado_por text DEFAULT org.usuario_actual()
);
CREATE TRIGGER arqueo_sin_update BEFORE UPDATE OR DELETE ON fin.arqueo FOR EACH ROW EXECUTE FUNCTION logic.inmutable();
CREATE TRIGGER arqueo_sin_truncate BEFORE TRUNCATE ON fin.arqueo FOR EACH STATEMENT EXECUTE FUNCTION logic.inmutable();

CREATE OR REPLACE FUNCTION fin.arquear(p_cuenta uuid, p_contado numeric, p_motivo text) RETURNS bigint AS $$
DECLARE v_sistema numeric(16,2); v_dif numeric(16,2); v_mov bigint; v_id bigint;
BEGIN
  PERFORM org.exigir_finanzas();
  IF (SELECT tipo FROM fin.cuenta WHERE id = p_cuenta) IS DISTINCT FROM 'caja' THEN
    RAISE EXCEPTION 'El arqueo es de cajas: un banco se concilia contra el extracto.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fin.cuenta:' || p_cuenta::text));
  SELECT saldo INTO v_sistema FROM fin.saldo_cuenta WHERE cuenta_id = p_cuenta;
  v_dif := p_contado - v_sistema;
  IF v_dif <> 0 THEN
    INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto)
    VALUES (current_date, p_cuenta, 'arqueo', GREATEST(v_dif, 0), GREATEST(-v_dif, 0),
            CASE WHEN v_dif > 0 THEN 'Sobrante de arqueo: ' ELSE 'Faltante de arqueo: ' END || p_motivo)
    RETURNING id INTO v_mov;
  END IF;
  INSERT INTO fin.arqueo (cuenta_id, sistema, contado, movimiento_id, motivo)
  VALUES (p_cuenta, v_sistema, p_contado, v_mov, p_motivo) RETURNING id INTO v_id;
  RETURN v_id;
END $$ LANGUAGE plpgsql;

-- ── Órdenes de pago ──────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE fin.orden_pago_numero_seq;
CREATE TABLE fin.orden_pago (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero             bigint NOT NULL UNIQUE DEFAULT nextval('fin.orden_pago_numero_seq'),
  proveedor_id       uuid NOT NULL REFERENCES logic.proveedor(id),
  fecha              date NOT NULL DEFAULT current_date,
  estado             text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','registrada','anulada')),
  notas              text,
  -- Se fijan al registrar.
  total_valores      numeric(16,2),
  total_retenciones  numeric(16,2),
  total_aplicado     numeric(16,2),
  a_cuenta           numeric(16,2),
  creado_por         text DEFAULT org.usuario_actual(),
  creado_en          timestamptz NOT NULL DEFAULT now(),
  registrado_por     text,
  registrado_en      timestamptz,
  anulado_por        text,
  anulado_en         timestamptz,
  motivo_anulacion   text,
  CHECK (estado <> 'anulada' OR motivo_anulacion IS NOT NULL)
);
ALTER TABLE fin.movimiento_tes ADD CONSTRAINT movimiento_tes_op_fk FOREIGN KEY (orden_pago_id) REFERENCES fin.orden_pago(id);
ALTER TABLE fin.cheque ADD CONSTRAINT cheque_op_fk FOREIGN KEY (orden_pago_id) REFERENCES fin.orden_pago(id);
ALTER TABLE fin.movimiento_cc ADD COLUMN orden_pago_id uuid REFERENCES fin.orden_pago(id);

-- Qué comprobantes cancela. En una factura o nota de débito, cuánto de su pendiente; en una nota
-- de crédito sin factura asociada, cuánto de su crédito se usa (resta del total a pagar).
CREATE TABLE fin.orden_pago_aplicacion (
  orden_pago_id   uuid NOT NULL REFERENCES fin.orden_pago(id) ON DELETE CASCADE,
  comprobante_id  uuid NOT NULL REFERENCES fin.comprobante(id),
  importe         numeric(16,2) NOT NULL CHECK (importe > 0),
  PRIMARY KEY (orden_pago_id, comprobante_id)
);
CREATE INDEX orden_pago_aplicacion_comp_ix ON fin.orden_pago_aplicacion (comprobante_id);

-- Retenciones practicadas, cargadas a mano (decisión de Fer): importe y certificado.
CREATE TABLE fin.orden_pago_retencion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_pago_id  uuid NOT NULL REFERENCES fin.orden_pago(id) ON DELETE CASCADE,
  impuesto       text NOT NULL CHECK (impuesto IN ('ganancias','iva','iibb','suss','otra')),
  jurisdiccion   text,
  regimen        text,
  certificado    text,
  importe        numeric(16,2) NOT NULL CHECK (importe > 0)
);

-- Con qué se paga.
CREATE TABLE fin.orden_pago_valor (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_pago_id      uuid NOT NULL REFERENCES fin.orden_pago(id) ON DELETE CASCADE,
  medio              text NOT NULL CHECK (medio IN ('transferencia','efectivo','cheque_propio','cheque_tercero')),
  cuenta_id          uuid REFERENCES fin.cuenta(id),
  cheque_id          uuid REFERENCES fin.cheque(id),       -- tercero: el de la cartera; propio: el emitido al registrar
  importe            numeric(16,2) NOT NULL CHECK (importe > 0),
  referencia         text,                                 -- número de transferencia, comprobante
  cheque_numero      text,                                 -- propio: datos para emitirlo al registrar
  cheque_formato     text CHECK (cheque_formato IS NULL OR cheque_formato IN ('fisico','echeq')),
  cheque_fecha_pago  date,
  CHECK (medio NOT IN ('transferencia','efectivo','cheque_propio') OR cuenta_id IS NOT NULL),
  CHECK (medio <> 'cheque_tercero' OR cheque_id IS NOT NULL),
  CHECK (medio <> 'cheque_propio' OR (cheque_numero IS NOT NULL AND cheque_fecha_pago IS NOT NULL))
);

-- El detalle se edita sólo en borrador.
CREATE OR REPLACE FUNCTION fin.orden_pago_detalle_cerrado() RETURNS trigger AS $$
DECLARE est text;
BEGIN
  SELECT estado INTO est FROM fin.orden_pago
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.orden_pago_id ELSE NEW.orden_pago_id END;
  IF est IS NOT NULL AND est <> 'borrador' THEN
    RAISE EXCEPTION 'La orden de pago está %: no se modifica.', est;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER op_aplicacion_cerrada BEFORE INSERT OR UPDATE OR DELETE ON fin.orden_pago_aplicacion
  FOR EACH ROW EXECUTE FUNCTION fin.orden_pago_detalle_cerrado();
CREATE TRIGGER op_retencion_cerrada BEFORE INSERT OR UPDATE OR DELETE ON fin.orden_pago_retencion
  FOR EACH ROW EXECUTE FUNCTION fin.orden_pago_detalle_cerrado();
-- El cheque_id del valor de cheque propio se completa al registrar, con la orden ya registrada:
-- se permite sólo ese cambio.
CREATE OR REPLACE FUNCTION fin.orden_pago_valor_cerrado() RETURNS trigger AS $$
DECLARE est text;
BEGIN
  SELECT estado INTO est FROM fin.orden_pago
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.orden_pago_id ELSE NEW.orden_pago_id END;
  IF est IS NULL OR est = 'borrador' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'UPDATE' AND OLD.cheque_id IS NULL AND NEW.cheque_id IS NOT NULL AND NEW.medio = 'cheque_propio'
     AND (NEW.importe, NEW.cuenta_id, NEW.medio) IS NOT DISTINCT FROM (OLD.importe, OLD.cuenta_id, OLD.medio) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'La orden de pago está %: no se modifica.', est;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER op_valor_cerrado BEFORE INSERT OR UPDATE OR DELETE ON fin.orden_pago_valor
  FOR EACH ROW EXECUTE FUNCTION fin.orden_pago_valor_cerrado();

CREATE OR REPLACE FUNCTION fin.orden_pago_cerrada() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'borrador' THEN RAISE EXCEPTION 'Sólo se borra una orden de pago en borrador; una registrada se anula.'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.estado = 'anulada' THEN RAISE EXCEPTION 'La orden de pago está anulada: no cambia más.'; END IF;
  IF OLD.estado = 'registrada' AND (NEW.estado <> 'anulada' OR
       (NEW.proveedor_id, NEW.fecha, NEW.total_valores, NEW.total_retenciones, NEW.total_aplicado, NEW.a_cuenta)
       IS DISTINCT FROM (OLD.proveedor_id, OLD.fecha, OLD.total_valores, OLD.total_retenciones, OLD.total_aplicado, OLD.a_cuenta)) THEN
    RAISE EXCEPTION 'La orden de pago está registrada: no se modifica. Anulala y hacé otra.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER orden_pago_cerrada BEFORE UPDATE OR DELETE ON fin.orden_pago
  FOR EACH ROW EXECUTE FUNCTION fin.orden_pago_cerrada();

-- ── Pendiente por comprobante ────────────────────────────────────────────────────────────────
-- Ahora descuenta también lo aplicado por órdenes de pago registradas. Las notas de crédito sin
-- factura asociada tienen su propio pendiente: el crédito que queda por usar.
CREATE OR REPLACE VIEW fin.comprobante_pendiente AS
SELECT c.id AS comprobante_id, c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha,
       COALESCE(c.vencimiento, c.fecha) AS vencimiento,
       c.total - COALESCE((SELECT SUM(n.total) FROM fin.comprobante n
                            WHERE n.asociado_id = c.id AND n.tipo = 'nota_credito' AND n.estado = 'registrado'), 0)
               - COALESCE((SELECT SUM(a.importe) FROM fin.orden_pago_aplicacion a JOIN fin.orden_pago o ON o.id = a.orden_pago_id
                            WHERE a.comprobante_id = c.id AND o.estado = 'registrada'), 0) AS pendiente
  FROM fin.comprobante c
 WHERE c.estado = 'registrado' AND c.tipo IN ('factura','nota_debito');

CREATE VIEW fin.credito_pendiente AS
SELECT c.id AS comprobante_id, c.proveedor_id, c.letra, c.punto_venta, c.numero, c.fecha,
       c.total - COALESCE((SELECT SUM(a.importe) FROM fin.orden_pago_aplicacion a JOIN fin.orden_pago o ON o.id = a.orden_pago_id
                            WHERE a.comprobante_id = c.id AND o.estado = 'registrada'), 0) AS disponible
  FROM fin.comprobante c
 WHERE c.estado = 'registrado' AND c.tipo = 'nota_credito' AND c.asociado_id IS NULL;

-- Una factura con pagos aplicados no se anula: primero se anula la orden de pago.
CREATE OR REPLACE FUNCTION fin.comprobante_sin_pagos() RETURNS trigger AS $$
BEGIN
  IF NEW.estado = 'anulado' AND OLD.estado = 'registrado' AND EXISTS (
       SELECT 1 FROM fin.orden_pago_aplicacion a JOIN fin.orden_pago o ON o.id = a.orden_pago_id
        WHERE a.comprobante_id = NEW.id AND o.estado = 'registrada') THEN
    RAISE EXCEPTION 'El comprobante tiene pagos aplicados: anulá primero la orden de pago.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER comprobante_sin_pagos BEFORE UPDATE OF estado ON fin.comprobante
  FOR EACH ROW EXECUTE FUNCTION fin.comprobante_sin_pagos();

-- ── Registrar y anular una orden de pago ─────────────────────────────────────────────────────
-- Todo en una transacción y en la base: valida lo aplicado contra lo pendiente, mueve las cuentas
-- de tesorería, emite o endosa los cheques y cancela la deuda en la cuenta corriente por el bruto
-- (valores más retenciones). Lo que sobra sobre lo aplicado queda como pago a cuenta.
CREATE OR REPLACE FUNCTION fin.registrar_orden_pago(p_id uuid) RETURNS void AS $$
DECLARE
  op record; a record; v record; ch record;
  v_valores numeric(16,2); v_ret numeric(16,2); v_aplicado numeric(16,2); v_pend numeric(16,2);
  v_cheque uuid; nro text;
BEGIN
  PERFORM org.exigir_finanzas();
  SELECT * INTO op FROM fin.orden_pago WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa orden de pago.'; END IF;
  IF op.estado <> 'borrador' THEN RAISE EXCEPTION 'La orden de pago ya está %.', op.estado; END IF;
  nro := 'OP-' || lpad(op.numero::text, 6, '0');
  -- Bloquea el proveedor: dos órdenes simultáneas no pueden aplicar el mismo pendiente.
  PERFORM pg_advisory_xact_lock(hashtext('fin.proveedor:' || op.proveedor_id::text));

  v_aplicado := 0;
  FOR a IN SELECT x.*, c.tipo, c.proveedor_id, c.estado AS c_estado,
                  'Comprobante ' || c.letra || ' ' || lpad(c.punto_venta::text, 5, '0') || '-' || lpad(c.numero::text, 8, '0') AS descr
             FROM fin.orden_pago_aplicacion x JOIN fin.comprobante c ON c.id = x.comprobante_id
            WHERE x.orden_pago_id = p_id LOOP
    IF a.proveedor_id <> op.proveedor_id OR a.c_estado <> 'registrado' THEN
      RAISE EXCEPTION '% no es un comprobante registrado de este proveedor.', a.descr;
    END IF;
    IF a.tipo = 'nota_credito' THEN
      SELECT disponible INTO v_pend FROM fin.credito_pendiente WHERE comprobante_id = a.comprobante_id;
      IF v_pend IS NULL THEN RAISE EXCEPTION '%: una nota de crédito asociada a una factura ya descuenta de esa factura.', a.descr; END IF;
      IF a.importe > v_pend THEN RAISE EXCEPTION '%: se aplican % y quedan % de crédito.', a.descr, a.importe, v_pend; END IF;
      v_aplicado := v_aplicado - a.importe;
    ELSE
      SELECT pendiente INTO v_pend FROM fin.comprobante_pendiente WHERE comprobante_id = a.comprobante_id;
      IF a.importe > v_pend THEN RAISE EXCEPTION '%: se aplican % y el pendiente es %.', a.descr, a.importe, v_pend; END IF;
      v_aplicado := v_aplicado + a.importe;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(importe), 0) INTO v_ret FROM fin.orden_pago_retencion WHERE orden_pago_id = p_id;
  SELECT COALESCE(SUM(importe), 0) INTO v_valores FROM fin.orden_pago_valor WHERE orden_pago_id = p_id;
  IF v_valores + v_ret <= 0 THEN RAISE EXCEPTION 'La orden de pago no tiene valores ni retenciones.'; END IF;
  IF v_valores + v_ret < v_aplicado THEN
    RAISE EXCEPTION 'Lo aplicado (%) supera lo que se paga (valores % + retenciones %).', v_aplicado, v_valores, v_ret;
  END IF;

  FOR v IN SELECT * FROM fin.orden_pago_valor WHERE orden_pago_id = p_id LOOP
    IF v.medio IN ('transferencia','efectivo') THEN
      IF (SELECT tipo FROM fin.cuenta WHERE id = v.cuenta_id) <> (CASE v.medio WHEN 'transferencia' THEN 'banco' ELSE 'caja' END) THEN
        RAISE EXCEPTION '%', CASE v.medio WHEN 'transferencia' THEN 'Una transferencia sale de una cuenta bancaria.'
                                          ELSE 'Un pago en efectivo sale de una caja.' END;
      END IF;
      INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, orden_pago_id)
      VALUES (op.fecha, v.cuenta_id, 'pago', v.importe,
              nro || ' · ' || initcap(v.medio) || COALESCE(' ' || v.referencia, ''), p_id);
    ELSIF v.medio = 'cheque_propio' THEN
      IF (SELECT tipo FROM fin.cuenta WHERE id = v.cuenta_id) <> 'banco' THEN
        RAISE EXCEPTION 'Un cheque propio es de una cuenta bancaria.';
      END IF;
      INSERT INTO fin.cheque (tipo, formato, banco, numero, importe, fecha_emision, fecha_pago, cuenta_id, estado, proveedor_id, orden_pago_id)
      VALUES ('propio', COALESCE(v.cheque_formato, 'fisico'), (SELECT COALESCE(banco, nombre) FROM fin.cuenta WHERE id = v.cuenta_id),
              v.cheque_numero, v.importe, op.fecha, v.cheque_fecha_pago, v.cuenta_id, 'emitido', op.proveedor_id, p_id)
      RETURNING id INTO v_cheque;
      UPDATE fin.orden_pago_valor SET cheque_id = v_cheque WHERE id = v.id;
    ELSE
      SELECT * INTO ch FROM fin.cheque WHERE id = v.cheque_id FOR UPDATE;
      IF ch.tipo <> 'tercero' OR ch.estado <> 'en_cartera' THEN
        RAISE EXCEPTION 'El cheque % Nº % no está en cartera.', ch.banco, ch.numero;
      END IF;
      IF ch.importe <> v.importe THEN
        RAISE EXCEPTION 'El cheque % Nº % es por %: se endosa entero.', ch.banco, ch.numero, ch.importe;
      END IF;
      UPDATE fin.cheque SET estado = 'endosado', proveedor_id = op.proveedor_id, orden_pago_id = p_id WHERE id = ch.id;
      INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, orden_pago_id, cheque_id)
      VALUES (op.fecha, fin.cartera(), 'endoso', v.importe, nro || ' · endoso cheque ' || ch.banco || ' Nº ' || ch.numero, p_id, ch.id);
    END IF;
  END LOOP;

  UPDATE fin.orden_pago SET estado = 'registrada', registrado_en = now(), registrado_por = org.usuario_actual(),
         total_valores = v_valores, total_retenciones = v_ret, total_aplicado = v_aplicado,
         a_cuenta = v_valores + v_ret - v_aplicado
   WHERE id = p_id;
  INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, debe, detalle, orden_pago_id)
  VALUES (op.fecha, op.proveedor_id, 'pago', v_valores + v_ret,
          'Orden de pago ' || nro || CASE WHEN v_ret > 0 THEN ' (incluye retenciones ' || v_ret || ')' ELSE '' END, p_id);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fin.anular_orden_pago(p_id uuid, p_motivo text) RETURNS void AS $$
DECLARE op record; m record; ch record;
BEGIN
  PERFORM org.exigir_finanzas();
  IF coalesce(btrim(p_motivo), '') = '' THEN RAISE EXCEPTION 'Falta el motivo de la anulación.'; END IF;
  SELECT * INTO op FROM fin.orden_pago WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa orden de pago.'; END IF;
  IF op.estado <> 'registrada' THEN RAISE EXCEPTION 'Sólo se anula una orden de pago registrada (un borrador se borra).'; END IF;
  IF EXISTS (SELECT 1 FROM fin.cheque WHERE orden_pago_id = p_id AND tipo = 'propio' AND estado = 'debitado') THEN
    RAISE EXCEPTION 'Un cheque propio de esta orden ya se debitó: la plata ya salió del banco.';
  END IF;
  -- Cada movimiento de tesorería de la orden, al revés.
  FOR m IN SELECT * FROM fin.movimiento_tes WHERE orden_pago_id = p_id AND anula_a IS NULL AND tipo <> 'anulacion' LOOP
    INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, orden_pago_id, cheque_id, anula_a)
    VALUES (current_date, m.cuenta_id, 'anulacion', m.salida, m.entrada, 'Anula: ' || m.concepto || ' — ' || p_motivo, p_id, m.cheque_id, m.id);
  END LOOP;
  UPDATE fin.cheque SET estado = 'anulado' WHERE orden_pago_id = p_id AND tipo = 'propio' AND estado = 'emitido';
  UPDATE fin.cheque SET estado = 'en_cartera', proveedor_id = NULL, orden_pago_id = NULL
   WHERE orden_pago_id = p_id AND tipo = 'tercero' AND estado = 'endosado';
  SELECT * INTO m FROM fin.movimiento_cc WHERE orden_pago_id = p_id AND anula_a IS NULL AND tipo = 'pago';
  INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, haber, detalle, anula_a, orden_pago_id)
  VALUES (current_date, m.proveedor_id, 'anulacion', m.debe, 'Anula: ' || m.detalle || ' — ' || p_motivo, m.id, p_id);
  UPDATE fin.orden_pago SET estado = 'anulada', anulado_en = now(), anulado_por = org.usuario_actual(), motivo_anulacion = p_motivo
   WHERE id = p_id;
END $$ LANGUAGE plpgsql;

-- ── Conciliación bancaria ────────────────────────────────────────────────────────────────────
CREATE TABLE fin.extracto (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id      uuid NOT NULL REFERENCES fin.cuenta(id),
  archivo        text,
  importado_en   timestamptz NOT NULL DEFAULT now(),
  importado_por  text DEFAULT org.usuario_actual(),
  lineas_nuevas  int NOT NULL DEFAULT 0,
  lineas_repetidas int NOT NULL DEFAULT 0
);

-- Una línea del extracto. Importe con signo: positivo entra, negativo sale. La clave única hace
-- idempotente la importación: el mismo archivo subido dos veces no duplica nada. `ocurrencia`
-- distingue dos líneas idénticas del mismo día (dos débitos iguales existen).
CREATE TABLE fin.extracto_linea (
  id          bigserial PRIMARY KEY,
  extracto_id uuid NOT NULL REFERENCES fin.extracto(id),
  cuenta_id   uuid NOT NULL REFERENCES fin.cuenta(id),
  fecha       date NOT NULL,
  concepto    text NOT NULL DEFAULT '',
  referencia  text NOT NULL DEFAULT '',
  importe     numeric(16,2) NOT NULL CHECK (importe <> 0),
  ocurrencia  int NOT NULL DEFAULT 1,
  UNIQUE (cuenta_id, fecha, importe, concepto, referencia, ocurrencia)
);
CREATE INDEX extracto_linea_ix ON fin.extracto_linea (cuenta_id, fecha);

-- El pareo de una línea con un movimiento. No es un registro contable: se puede deshacer.
CREATE TABLE fin.conciliacion (
  linea_id         bigint PRIMARY KEY REFERENCES fin.extracto_linea(id),
  movimiento_id    bigint NOT NULL UNIQUE REFERENCES fin.movimiento_tes(id),
  conciliado_en    timestamptz NOT NULL DEFAULT now(),
  conciliado_por   text DEFAULT org.usuario_actual()
);
-- Sólo se parea lo que coincide: misma cuenta y mismo importe con signo.
CREATE OR REPLACE FUNCTION fin.conciliacion_coherente() RETURNS trigger AS $$
DECLARE l record; m record;
BEGIN
  PERFORM org.exigir_finanzas();
  SELECT cuenta_id, importe INTO l FROM fin.extracto_linea WHERE id = NEW.linea_id;
  SELECT cuenta_id, entrada - salida AS importe INTO m FROM fin.movimiento_tes WHERE id = NEW.movimiento_id;
  IF l.cuenta_id <> m.cuenta_id THEN RAISE EXCEPTION 'La línea y el movimiento son de cuentas distintas.'; END IF;
  IF l.importe <> m.importe THEN RAISE EXCEPTION 'La línea (%) y el movimiento (%) no tienen el mismo importe.', l.importe, m.importe; END IF;
  NEW.conciliado_por := COALESCE(org.usuario_actual(), NEW.conciliado_por);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER conciliacion_coherente BEFORE INSERT OR UPDATE ON fin.conciliacion
  FOR EACH ROW EXECUTE FUNCTION fin.conciliacion_coherente();
