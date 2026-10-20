-- Catálogo externo: lo que una base pública (Open Food Facts) dice de un GTIN de fabricante.
--
-- Sirve para precompletar el alta de un producto al escanear un envase: nombre, marca y contenido.
-- Es una SUGERENCIA, no un dato del negocio: nada de acá se copia solo a logic.producto. Lo que
-- termina guardado es lo que el encargado revisó en el formulario.
--
-- Se guarda también cuando NO se encontró, para no consultar de nuevo el mismo código a cada
-- escaneo. La app vuelve a preguntar pasado un tiempo (la base pública crece).
CREATE TABLE logic.catalogo_externo (
  gtin           text PRIMARY KEY CHECK (logic.gtin_valido(gtin)),
  fuente         text NOT NULL,
  encontrado     boolean NOT NULL,
  nombre         text,
  marca          text,
  contenido      text,      -- tal como lo publica la fuente: "500 g", "1,5 l"
  cantidad       numeric CHECK (cantidad > 0),
  unidad         text REFERENCES logic.unidad(codigo),
  categoria      text,
  consultado_en  timestamptz NOT NULL DEFAULT now(),
  CHECK ((cantidad IS NULL) = (unidad IS NULL))
);
