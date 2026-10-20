-- La foto del catálogo externo se guarda en la caché la primera vez que se pide la vista previa.
--
-- El servidor de imágenes de Open Food Facts puede tardar varios segundos por foto (medido: 5 a
-- 9 s, casi todo en el saludo TLS). Bajándola una vez durante la vista previa, mientras el
-- encargado completa el formulario, al guardar el producto se copia desde acá sin volver a salir.
ALTER TABLE logic.catalogo_externo
  ADD COLUMN imagen     bytea CHECK (octet_length(imagen) <= 1048576),
  ADD COLUMN miniatura  bytea CHECK (octet_length(miniatura) <= 65536);
