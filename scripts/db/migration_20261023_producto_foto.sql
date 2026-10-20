-- Foto de producto: una por producto, propia (sacada con el celular) o copiada de Open Food Facts.
--
-- Va en la base y no en el disco: el contenedor de la app se reconstruye en cada deploy y lo que
-- haya en su disco se pierde; acá entra en el respaldo. Son unos 100 KB por producto.
--
-- Se guarda una COPIA aunque venga de afuera: mostrarla desde el servidor de Open Food Facts le
-- contaría a un tercero qué productos se miran, y si ese servicio se cae la app queda sin fotos.
-- Sus fotos son CC BY-SA: se pueden usar citando la fuente, que queda en `atribucion`.
CREATE TABLE logic.producto_foto (
  producto_id     uuid PRIMARY KEY REFERENCES logic.producto(id) ON DELETE CASCADE,
  datos           bytea NOT NULL CHECK (octet_length(datos) <= 1048576),
  miniatura       bytea NOT NULL CHECK (octet_length(miniatura) <= 65536),
  origen          text NOT NULL CHECK (origen IN ('propia', 'openfoodfacts')),
  atribucion      text,
  fuente_url      text,
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  CHECK (origen = 'propia' OR atribucion IS NOT NULL)
);

-- El catálogo externo pasa a recordar dónde está la foto del frente del envase.
ALTER TABLE logic.catalogo_externo ADD COLUMN imagen_url text, ADD COLUMN miniatura_url text;
-- Es sólo una caché: lo consultado antes de esta columna se vuelve a pedir para traer la foto.
DELETE FROM logic.catalogo_externo;
