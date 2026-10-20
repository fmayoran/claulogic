-- Fase 0: autenticación y permisos por sede.
--
-- Esquema `org`: sedes, usuarios, roles por sede, sesiones y dispositivos de cocina. Va aparte de
-- `logic` por la misma razón que `logic` va aparte de `public`: un dump o un GRANT de usuarios no
-- tiene por qué arrastrar el stock, ni al revés.
--
-- Quién hizo cada cosa lo asienta la BASE, no la aplicación: la app fija `logic.usuario` en cada
-- conexión que toma del pool, y los triggers del libro mayor, los conteos y las lecturas de frío lo
-- leen. Esos mismos triggers verifican que el usuario tenga rol para operar en la sede de la
-- ubicación. Así una pantalla nueva que se olvide de chequear permisos no abre un agujero.
CREATE SCHEMA org;

-- ── Sedes ────────────────────────────────────────────────────────────────────────────────────
-- El centro de abastecimiento y producción, y cada local. La fase 1 agrega las que falten; hoy
-- existe una sola y todos los almacenes le pertenecen.
CREATE TABLE org.sede (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  tipo       text NOT NULL CHECK (tipo IN ('centro','local')),
  direccion  text,
  activa     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sede_nombre_ux ON org.sede (lower(btrim(nombre)));
INSERT INTO org.sede (nombre, tipo) VALUES ('Centro', 'centro');

ALTER TABLE logic.almacen ADD COLUMN sede_id uuid REFERENCES org.sede(id);
UPDATE logic.almacen SET sede_id = (SELECT id FROM org.sede);
ALTER TABLE logic.almacen ALTER COLUMN sede_id SET NOT NULL;
CREATE INDEX almacen_sede_ix ON logic.almacen (sede_id);

-- ── Usuarios ─────────────────────────────────────────────────────────────────────────────────
-- `usuario` es el nombre de ingreso y lo que queda escrito en `registrado_por` de cada movimiento.
-- Por eso no cambia nunca: renombrarlo dejaría el historial firmado por alguien que ya no existe.
-- Las claves y los PIN se guardan con scrypt (lo calcula la app); acá sólo el resultado.
CREATE TABLE org.usuario (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario             text NOT NULL UNIQUE CHECK (usuario ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  nombre              text NOT NULL CHECK (btrim(nombre) <> ''),
  clave_hash          text NOT NULL,
  debe_cambiar_clave  boolean NOT NULL DEFAULT true,
  pin_hash            text,
  es_admin            boolean NOT NULL DEFAULT false,
  activo              boolean NOT NULL DEFAULT true,
  -- Intentos fallidos seguidos. La clave bloquea 15 minutos al quinto; el PIN se inhabilita al
  -- quinto hasta que el usuario vuelva a entrar con su clave.
  fallos_clave        int NOT NULL DEFAULT 0,
  bloqueado_hasta     timestamptz,
  fallos_pin          int NOT NULL DEFAULT 0,
  clave_cambiada_en   timestamptz NOT NULL DEFAULT now(),
  creado_en           timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION org.usuario_fijo() RETURNS trigger AS $$
BEGIN
  IF NEW.usuario <> OLD.usuario THEN
    RAISE EXCEPTION 'El nombre de usuario no se cambia: es la firma del historial. Creá otro usuario.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER usuario_fijo BEFORE UPDATE OF usuario ON org.usuario
  FOR EACH ROW EXECUTE FUNCTION org.usuario_fijo();

-- Un usuario que firmó algo no se borra: se desactiva.
CREATE OR REPLACE FUNCTION org.usuario_sin_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Un usuario no se borra: se desactiva, y su firma sigue en el historial.';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER usuario_sin_delete BEFORE DELETE ON org.usuario
  FOR EACH ROW EXECUTE FUNCTION org.usuario_sin_delete();

-- Sin un administrador activo nadie puede dar de alta usuarios ni repartir roles, y la única
-- salida sería la consola. Se frena antes.
CREATE OR REPLACE FUNCTION org.queda_un_admin() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM org.usuario WHERE es_admin AND activo) THEN
    RAISE EXCEPTION 'Tiene que quedar al menos un administrador activo.';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER usuario_queda_admin AFTER UPDATE OF es_admin, activo ON org.usuario
  FOR EACH STATEMENT EXECUTE FUNCTION org.queda_un_admin();

-- Rol por sede. El administrador es global y no necesita filas acá.
--   encargado: opera y gestiona su sede (almacenes, ubicaciones, anulaciones); en el centro,
--              además, el catálogo, las recetas y las compras.
--   operador:  registra: conteos, egresos, traslados, recepción, producción, lecturas de frío.
--   consulta:  mira.
CREATE TABLE org.usuario_sede (
  usuario_id  uuid NOT NULL REFERENCES org.usuario(id) ON DELETE CASCADE,
  sede_id     uuid NOT NULL REFERENCES org.sede(id),
  rol         text NOT NULL CHECK (rol IN ('encargado','operador','consulta')),
  PRIMARY KEY (usuario_id, sede_id)
);

-- ── Dispositivos de cocina ───────────────────────────────────────────────────────────────────
-- Una tablet compartida que un encargado habilitó entrando con su clave. Sólo ahí se puede
-- cambiar de usuario con PIN: un PIN de 4 a 6 dígitos no protege nada en un navegador cualquiera.
CREATE TABLE org.dispositivo (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      bytea NOT NULL UNIQUE,
  descripcion     text,
  habilitado_por  uuid NOT NULL REFERENCES org.usuario(id),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  usado_en        timestamptz NOT NULL DEFAULT now(),
  vence_en        timestamptz NOT NULL,
  revocado_en     timestamptz
);

-- ── Sesiones ─────────────────────────────────────────────────────────────────────────────────
-- Se guarda el sha256 del token, no el token: un dump de la base no sirve para entrar.
-- Vence por inactividad o al llegar a `vence_en`, lo que pase primero.
CREATE TABLE org.sesion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      bytea NOT NULL UNIQUE,
  usuario_id      uuid NOT NULL REFERENCES org.usuario(id),
  dispositivo_id  uuid REFERENCES org.dispositivo(id),
  metodo          text NOT NULL CHECK (metodo IN ('clave','pin')),
  creada_en       timestamptz NOT NULL DEFAULT now(),
  usada_en        timestamptz NOT NULL DEFAULT now(),
  inactividad     interval NOT NULL,
  vence_en        timestamptz NOT NULL,
  cerrada_en      timestamptz,
  ip              text,
  agente          text
);
CREATE INDEX sesion_usuario_ix ON org.sesion (usuario_id) WHERE cerrada_en IS NULL;

-- ── Registro de accesos ──────────────────────────────────────────────────────────────────────
-- Entradas, fallos, bloqueos y cambios de clave o de permisos. Inmutable como el libro mayor: es
-- lo que se mira cuando alguien dice "yo no fui".
CREATE TABLE org.acceso (
  id           bigserial PRIMARY KEY,
  ocurrido_en  timestamptz NOT NULL DEFAULT now(),
  usuario      text,                -- el tipeado, aunque no exista: también es un dato
  evento       text NOT NULL,
  ip           text,
  detalle      text,
  por          text                 -- quién lo hizo, cuando no es el mismo usuario (un admin)
);
CREATE INDEX acceso_ix ON org.acceso (ocurrido_en DESC);
CREATE TRIGGER acceso_sin_update BEFORE UPDATE OR DELETE ON org.acceso
  FOR EACH ROW EXECUTE FUNCTION logic.inmutable();
CREATE TRIGGER acceso_sin_truncate BEFORE TRUNCATE ON org.acceso
  FOR EACH STATEMENT EXECUTE FUNCTION logic.inmutable();

-- ── Permisos en la base ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION org.usuario_actual() RETURNS text AS $$
  SELECT NULLIF(current_setting('logic.usuario', true), '')
$$ LANGUAGE sql STABLE;

-- ¿Puede el usuario de la conexión registrar operaciones en la sede de esta ubicación?
-- Desde la app (`logic.origen = app`, lo fija la cadena de conexión) siempre tiene que haber
-- usuario: si falta, es un error de la app y se frena en vez de asentar algo sin firma. Desde la
-- consola no hay usuario y no se verifica: quien entra a psql ya tiene la llave de todo.
CREATE OR REPLACE FUNCTION org.exigir_operar(p_ubicacion uuid) RETURNS void AS $$
DECLARE
  v_usuario text := org.usuario_actual();
  v_sede    uuid;
  v_nombre  text;
BEGIN
  IF v_usuario IS NULL THEN
    IF current_setting('logic.origen', true) = 'app' THEN
      RAISE EXCEPTION 'No hay usuario identificado: volvé a iniciar sesión.';
    END IF;
    RETURN;
  END IF;
  IF p_ubicacion IS NULL THEN RETURN; END IF;
  SELECT s.id, s.nombre INTO v_sede, v_nombre
    FROM logic.ubicacion u
    JOIN logic.almacen a ON a.id = u.almacen_id
    JOIN org.sede s ON s.id = a.sede_id
   WHERE u.id = p_ubicacion;
  IF NOT FOUND THEN RETURN; END IF;   -- la clave foránea lo rechaza después, con su mensaje
  IF NOT EXISTS (
       SELECT 1 FROM org.usuario us
        WHERE us.usuario = v_usuario AND us.activo
          AND (us.es_admin OR EXISTS (
                 SELECT 1 FROM org.usuario_sede x
                  WHERE x.usuario_id = us.id AND x.sede_id = v_sede
                    AND x.rol IN ('encargado','operador')))) THEN
    RAISE EXCEPTION 'No tenés permiso para registrar operaciones en la sede %.', v_nombre;
  END IF;
END $$ LANGUAGE plpgsql STABLE;

-- La firma la pone la base: si hay usuario en la conexión, es ése, diga lo que diga el INSERT.
-- Un traslado exige permiso en las dos puntas (en la fase 1 el traslado entre sedes pasa a ser un
-- remito con recepción del otro lado).
CREATE OR REPLACE FUNCTION logic.movimiento_firma() RETURNS trigger AS $$
BEGIN
  PERFORM org.exigir_operar(NEW.origen_id);
  PERFORM org.exigir_operar(NEW.destino_id);
  NEW.registrado_por := COALESCE(org.usuario_actual(), NEW.registrado_por);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movimiento_firma BEFORE INSERT ON logic.movimiento
  FOR EACH ROW EXECUTE FUNCTION logic.movimiento_firma();

CREATE OR REPLACE FUNCTION logic.ubicacion_firma() RETURNS trigger AS $$
BEGIN
  PERFORM org.exigir_operar(NEW.ubicacion_id);
  NEW.registrado_por := COALESCE(org.usuario_actual(), NEW.registrado_por);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ajuste_firma BEFORE INSERT ON logic.ajuste
  FOR EACH ROW EXECUTE FUNCTION logic.ubicacion_firma();
CREATE TRIGGER lectura_firma BEFORE INSERT ON logic.lectura_temperatura
  FOR EACH ROW EXECUTE FUNCTION logic.ubicacion_firma();
