# CLAUDE.md — ClauLogic

## Qué es esto
**ClauLogic es una aplicación independiente.** No es un componente de ClaUsina ni una cápsula de
negocio: tiene su propio repo, su propia base, su propia clave de cifrado y su propio proyecto en
EasyPanel. Lo único que comparte con ClaUsina es el VPS.

**No mezclar las dos.** Si una tarea es de ClaUsina, se hace parado en `/root/clausina`, con su
propio CLAUDE.md. Acá no se leen contextos de marca de ClaUsina ni se tocan sus archivos.

## Qué hace

**Gestión de almacén y producción para un negocio gastronómico.** Identificación de productos,
compras, control de stock, ingresos y egresos de mercadería, control de cámaras de frío, control
de almacenamiento, gestión de recetas y producción.

### Alcance ampliado (decidido el 20/10/2026)
Un **grupo gastronómico** con varios **locales** (puntos de venta) y gestión centralizada: la
administración financiera (tesorería, compras, pago a proveedores) y la logística, que opera desde
un **centro de abastecimiento y producción** (puede tener varios almacenes y varias unidades
productivas). ClauLogic NO es un punto de venta: se **integra** con los POS para traer las ventas,
por el lado financiero (cobros por medio de pago) y por el de consumo (artículo vendido → receta de
venta → descuento teórico de stock).

Decisiones de Fer:
- **Varios POS distintos** entre locales: formato de importación propio + un adaptador por sistema.
  La importación entra a una tabla de recepción idempotente (reimportar un cierre no duplica).
- **Stock por local**: cada local tiene almacén; centro → local es un traslado con remito interno.
  Ventas descuentan consumo teórico; los conteos del local dan la diferencia teórico vs. real.
- **Una sola razón social** (si aparecen más, se agrega con migración a facturas, cuentas y pagos).
- **Contabilidad afuera**: exportaciones para el sistema del contador, sin plan de cuentas propio.
- Los saldos financieros (cuenta corriente de proveedores, cajas y bancos) **se derivan de un libro
  mayor inmutable**, como el stock.
- Esquemas por área: `org` (sedes, usuarios), `logic` (lo existente), `fin` (proveedores, cuentas a
  pagar, tesorería), `pos` (importación de ventas).

Fases: 0 autenticación y permisos por sede → 1 sedes, almacenes por sede, unidades productivas,
traslados → 2 facturas de proveedor y cuenta corriente → 3 tesorería (pagos, retenciones,
conciliación) → 4 integración POS → 5 tablero (food cost, CMV, teórico vs. real, flujo de caja).

### Las cuatro decisiones del modelo (no las deshagas sin entender por qué están)

1. **El stock NO se guarda: se deriva.** No hay ninguna columna `cantidad_actual`. El stock sale
   de sumar `logic.movimiento`, que es un libro mayor inmutable. Guardar el stock como número es
   cómodo el primer día y es el origen de todos los problemas después: dos operaciones simultáneas
   lo pisan, una corrección a mano lo desvía, y cuando el número del sistema no coincide con el de
   la estantería nadie puede saber cuál miente ni desde cuándo. Derivándolo, cada unidad tiene su
   movimiento con fecha, motivo y responsable. Se consulta por `logic.stock` y `logic.stock_producto`.

2. **El libro mayor es inmutable, y se hace cumplir en la BASE.** Triggers bloquean UPDATE, DELETE
   y TRUNCATE sobre `logic.movimiento`. Para revertir algo se asienta un movimiento nuevo con
   `anula_a`, y quedan los dos. No se reescribe el pasado — ni desde la app, ni desde pgadmin, ni
   desde un script apurado.

3. **Todo en la unidad base del producto.** Se compra en cajas, se cocina en gramos y se cuenta en
   unidades. `logic.presentacion` convierte la presentación de compra a la base. `logic.unidad`
   tiene la magnitud (masa/volumen/conteo) para que no se pueda convertir kg a litros.

4. **Cantidades y plata en NUMERIC, nunca en float.** 0,1 + 0,2 en coma flotante no da 0,3, y un
   inventario que no cierra por centésimas es un inventario que nadie vuelve a mirar.

### Reglas que impone la base

- Un producto **perecedero exige lote** en cada movimiento: sin lote no hay vencimiento ni
  trazabilidad, que es lo que de verdad se le pide a un almacén gastronómico.
- Un lote tiene que pertenecer al producto del movimiento.
- Cantidades siempre positivas; el sentido lo dan `origen_id` y `destino_id`. Origen NULL = entra
  al sistema, destino NULL = sale, los dos = traslado.
- Una **cámara, heladera o freezer no se puede dar de alta sin rango de temperatura**: sin eso no
  hay contra qué comparar y el control de frío no existe.

- Todo producto pertenece a una **categoría**; toda ubicación (heladera, cámara) a un **almacén**.
- Un **ajuste** no escribe el stock: se registra lo contado y `logic.ajustar_stock` asienta el
  movimiento por la diferencia. El conteo queda en `logic.ajuste` aunque la diferencia sea cero.
- El **costo vigente** sí se guarda (`producto.costo_base`, por unidad base): actualizarlo es una
  decisión al recibir la compra (`compra_item.costo_decision`). Cada cambio lo asienta un trigger
  en `logic.costo_historial`, inmutable.
- El **stock puede quedar negativo** por ahora: decisión de Fer (20/10/2026), a revisar.

- Las **compras recibidas** no se editan ni se borran, y sus movimientos (como los de una
  producción) no se anulan sueltos. Recibir crea lote sólo para perecederos; los no perecederos se
  mueven sin lote.
- **Producir** recalcula el plan FEFO adentro de la transacción con los ingredientes bloqueados
  (`logic.bloquear_stock`) y no produce si algo no alcanza. La merma de la receta se suma sobre la
  cantidad neta: neto / (1 - merma).
- Las **unidades del sistema** (g, kg, ml, l, u) no cambian de equivalencia; las demás tampoco si
  son base de algún producto. La de **referencia** (una por magnitud) es la que muestra costos.
- La conexión fija la zona horaria en `America/Argentina/Buenos_Aires`: "hoy" es el de la cocina.

### Identificación (GS1)
- **SKU** = `producto.codigo`, propio del negocio. **GTIN** en `logic.gtin`, siempre en 14 dígitos
  con dígito verificador validado en la base.
- El GTIN de **fabricante** va en la **presentación** (cada nivel de empaque tiene el suyo: sachet
  y caja son códigos distintos). Escanearlo resuelve producto y cantidad.
- Todo producto nace con un **GTIN interno** con prefijo **040** (rango GS1 de circulación
  restringida dentro de una empresa, 040-049). No hay prefijo de empresa GS1 Argentina todavía:
  si se tramita, los elaborados pasan a GTIN reales. Los 04x los genera sólo la secuencia; un 04x
  tipeado o de otro fabricante se rechaza.
- **Código de lote** limitado a 20 caracteres del juego GS1 (sin espacios ni acentos): es el AI (10).
- **Etiqueta de lote** = QR con **GS1 Digital Link** (`/01/<GTIN>/10/<lote>?17=<AAMMDD>`); la app
  resuelve esa ruta y abre la trazabilidad. Etiqueta de góndola = EAN-13 del GTIN interno. Los
  códigos se generan en el servidor con `bwip-js`, con zona de silencio incluida.
- La lectura (`app/gs1.js`) entiende GTIN suelto, cadenas de AIs con o sin separador GS (los
  lectores en modo teclado lo mandan como Ctrl+]), formato entre paréntesis y Digital Link. Cámara:
  BarcodeDetector si el navegador lo trae; si no, `@zxing/library`, servido desde la app.
- La URL que va en los QR sale de `APP_URL` si está definida; si no, del pedido (`trust proxy`).
- **Catálogo externo** (`app/catalogo.js`): al escanear en Productos un GTIN desconocido se consulta
  **Open Food Facts** (base pública de la comunidad, 3 s de espera máxima) y se precompletan
  nombre, unidad base y presentación. Es sugerencia: nada se guarda en el producto sin que el
  encargado lo revise y guarde. Caché en `logic.catalogo_externo` (encontrados 180 días, no
  encontrados 30). Es la única llamada de la app a un tercero; si algún día hay prefijo GS1,
  la fuente oficial es Verified by GS1.
- **Foto de producto** (`app/fotos.js`, `logic.producto_foto`): una por producto, en la BASE (el
  disco del contenedor se pierde en cada deploy). Propia (el navegador la achica a 800 px + miniatura
  de 160 antes de subirla) o **copia** de Open Food Facts con atribución CC BY-SA obligatoria; nunca
  se enlaza al servidor de ellos. Sólo JPEG/PNG/WebP verificados por contenido (un SVG ejecutaría
  código). La descarga de afuera toma la URL de la caché, nunca del navegador, y exige el host.
  Su servidor de imágenes tarda 5-9 s: la vista previa la baja y la deja en la caché, y guardar
  la copia desde ahí.

### Lo que hay y lo que falta
Hay: panel, stock y conteos, movimientos (histórico, egresos, traslados, anulación), compras con
recepción y decisión de costo, recetas, producción con FEFO, trazabilidad por lote, frío,
productos (SKU y GTIN), etiquetas A4 con QR Digital Link y EAN-13, almacenes, proveedores y unidades.
Lectura de códigos con lector USB/Bluetooth o cámara en productos, compras, conteos y egresos. API en `app/*.js` (helpers comunes en `app/util.js`); pantallas
en `app/public/` con estilos y helpers compartidos en `comun.css` y `comun.js`.

**Interfaz.** `comun.js` arma la navegación de todas las pantallas: barra lateral agrupada desde
900 px; en el celular, barra inferior (Panel, Stock, Escanear, Productos, Más). **Escanear** es
global: producto abre su ficha, lote su trazabilidad, código desconocido va al alta
(`productos.html#nuevo/<gtin>`). Productos usa rutas en el `#` (`#p/<id>`, `#nuevo`) para que en
el celular listado y ficha sean pantallas separadas con el botón atrás funcionando. Tipografía
Archivo servida desde el paquete npm (`/vendor/archivo`), nunca de Google Fonts. Campos a 16 px en
el celular: con menos, el iPhone hace zoom al tocarlos.

Falta: **autenticación** (la app está publicada sin login; sin datos reales hasta que la tenga, y
`registrado_por` queda vacío), recepción parcial de compras, anular una compra recibida o una
producción entera, y lectura de sensores de temperatura.

## Sobre Fer
- Fernando Mayorano. Lic. en Sistemas, especialista en bases de datos, Desarrollo de Negocios.
- **Siempre responder en español**, con tildes y ñ correctas. **Sin emojis bajo ninguna circunstancia.**
- Tono directo, sin vueltas. Respuestas concisas pero completas.

## Reglas de seguridad
- Pedir confirmación antes de **borrar** cualquier archivo o carpeta.
- Pedir confirmación antes de **sobrescribir** archivos existentes.
- Nada que salga a producción o a un tercero sin visto humano.

## Arquitectura

| Pieza | Dónde |
|---|---|
| Repo | `github.com/fmayoran/claulogic` (branch `main`) |
| App | EasyPanel → proyecto `claulogic`, servicio `app` (Node 22 + Express, puerto 3002) |
| Base | EasyPanel → proyecto `claulogic`, servicio `db` (PostgreSQL 17 + pgvector) |
| Dominio | `https://claulogic.clausina.ar` (A a 72.60.166.136, proxy de Cloudflare APAGADO) |
| Secretos | `claulogic.env` en la raíz — gitignored, permisos 600 |

- **Base `claulogic`, esquema `logic`** (no `public`). Misma idea que `contenido` en ClaUsina: hace
  que un dump, un GRANT o un DROP sean quirúrgicos en vez de "todo o nada".
- **Instancia de Postgres propia**, separada de la de ClaUsina. No es purismo: en el Postgres de
  ClaUsina todo entra como superusuario, así que compartirlo habría dejado a cada app con acceso
  total a los datos de la otra.

## Cómo se trabaja

**Migraciones** — SQL numerado en `scripts/db/migration_AAAAMMDD_loquesea.sql`.
```bash
scripts/migrar.sh --ver     # qué está pendiente, sin tocar nada
scripts/migrar.sh           # aplicar
```
Cada una se aplica UNA vez y queda asentada en `logic.migracion` con su sha256. **Nunca edites una
migración ya aplicada**: el corredor lo detecta y frena, porque la base y el repo pasarían a contar
historias distintas. Si hay que corregir algo, se escribe una migración nueva.

**Deploy** — `./deploy.sh`. EasyPanel construye **desde GitHub**, no desde el disco, así que el
script se niega a desplegar con cambios sin commitear o sin pushear, y al final verifica que el
contenedor corra de verdad tu código comparando los archivos adentro. Las dos comprobaciones
existen porque en ClaUsina las dos fallaron alguna vez diciendo "OK".

**Secretos** — lo de plataforma en `claulogic.env`. Lo que el usuario opera desde la app va
**cifrado en la base** (AES-256-GCM, formato `gcm$<iv>$<ct||tag>`, helper `app/crypto.js`), nunca
en claro y nunca de vuelta al navegador. `APP_ENC_KEY` es **propia de ClauLogic**: no se comparte
con ClaUsina, o la independencia entre las dos se termina ahí.

**Respaldo** — lo cubre `/root/clausina/core/scripts/db_backup.sh`, que respalda las dos bases.
Vive en ClaUsina porque el cron ya estaba armado ahí; es la única dependencia operativa entre las
dos y está anotada a propósito.

## Trampas conocidas
- El proxy de Cloudflare va **apagado** en el A record. Prendido, Traefik no puede resolver el
  desafío de Let's Encrypt y el certificado nunca sale.
- El VPS **no tiene swap** y son 7,8 GB de RAM compartidos con ClaUsina, n8n y Chatwoot. Un pico
  de memoria no se degrada: lo mata el OOM killer.
- El contenedor de la base cambia de nombre en cada deploy
  (`claulogic_db.1.<hash>`): descubrilo con `docker ps -q -f name=claulogic_db.1.`, nunca lo fijes.
