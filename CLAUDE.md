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

### Autenticación y permisos (fase 0, 20/10/2026)
- Esquema `org`: `sede` (centro | local), `usuario`, `usuario_sede` (rol por sede), `sesion`,
  `dispositivo`, `acceso` (registro inmutable de entradas, fallos y cambios de permisos).
  `logic.almacen.sede_id` ata cada almacén a una sede; hoy hay una sola, "Centro".
- **Roles por sede**: encargado, operador, consulta. El **administrador** es global. El catálogo
  (productos, recetas, proveedores, unidades, compras) lo gestiona el **encargado del centro**.
  Anular un movimiento y configurar almacenes o ubicaciones es de encargado de esa sede. Mover el
  costo vigente al recibir una compra también es del catálogo: un operador recibe manteniendo costo.
- **La firma y el permiso por sede los pone la BASE**: la app fija `logic.usuario` en cada conexión
  que presta el pool (`db.js`, AsyncLocalStorage) y los triggers de `movimiento`, `ajuste` y
  `lectura_temperatura` verifican rol de encargado u operador en la sede de la ubicación y escriben
  `registrado_por`. Desde la app (`logic.origen=app` en la cadena de conexión) sin usuario, la base
  rechaza: falla cerrado. Desde psql no se verifica.
- Permiso por ruta en `app/auth.js` (`POLITICA`): una ruta que modifica y no está en la lista exige
  `catalogo`. Una ruta nueva arranca cerrada.
- Entrada con **usuario y clave** (scrypt N=2^15, ojo con la RAM antes de subirlo). Cookie HttpOnly,
  SameSite=Lax, en la base sólo el sha256 del token. Las mutaciones exigen `application/json` (CSRF).
  12 h de inactividad, 7 días como máximo. Al quinto fallo, 15 min de bloqueo; además, freno por IP.
- **PIN** (4-6 dígitos, sin series) sólo en un **dispositivo de cocina** que habilitó un encargado o
  admin entrando con su clave. Ahí las sesiones duran 30 min sin uso. Al quinto PIN malo se
  inhabilita hasta entrar con clave. Los dispositivos se revocan desde Usuarios.
- El nombre de usuario no cambia (firma el historial), un usuario no se borra (se desactiva) y la
  base no deja quedar sin administrador activo.
- **Primer administrador o recuperación** desde la consola del contenedor, que imprime una clave
  temporal: `docker exec -it $(docker ps -q -f name=claulogic_app.1.) node admin.js admin <usuario> "<Nombre>"`
  (o `... node admin.js clave <usuario>` para blanquear).

### Sedes, remitos y pedidos (fase 1, 21/10/2026)
- **Sedes**: las da de alta el administrador (`sedes.html`); un local nuevo nace con almacén
  "Depósito" y ubicación "General". El nombre de almacén es único **dentro de la sede**. Una sede con
  stock o con remitos abiertos no se desactiva.
- **Lo que cada uno ve**: stock, movimientos, ajustes, frío, producciones, remitos, pedidos, almacenes
  y unidades productivas, sólo de sus sedes (`filtroSedes` en `auth.js`, que además acepta
  `?sede=`). El catálogo es común. Las compras sólo las ve quien tiene rol en un centro.
- **Un traslado entre sedes sólo con remito**: lo rechaza el trigger `movimiento_firma` si no trae
  `remito_id`. Con remito, el permiso se verifica en la punta de la sede que despacha.
- **Remito** (`logic.remito`, `RI-000001`): borrador → despachado → recibido, o anulado. Decisión
  de Fer: **traslado directo**, sin stock en tránsito: despachar asienta los traslados al local en el
  momento. El local confirma lo recibido; la diferencia exige motivo y queda como **merma** (faltante)
  o **ajuste** (sobrante) atados al remito. Despachado y sin recibir, sólo el encargado de origen
  anula (vuelven los traslados). Recibido no se anula: remito de devolución. Despachar exige stock
  suficiente por lote y ubicación (a diferencia de los egresos sueltos).
- **Nota de pedido** (`logic.pedido`, `NP-000001`): manual, sin mínimos por local (decisión de Fer).
  El local la arma y la envía; el centro la convierte en remito con lotes por FEFO y avisa lo que
  no alcanza. Si se anula el remito, el pedido vuelve a "enviado".
- **Unidad productiva** (`logic.unidad_productiva`): sector de una sede con almacén de insumos y
  ubicación de salida de la misma sede. Recetas y producciones se asignan a una (opcional).
- Pendiente: mínimos de stock por sede (hoy el mínimo es uno por producto, y en una vista de varias
  sedes compararlo es orientativo).

### Finanzas: comprobantes y cuenta corriente (fase 2, 21/10/2026)
- Esquema `fin`. **Permiso de finanzas** global por usuario (`org.usuario.finanzas`, lo da un admin):
  todo `/api/fin/` lo exige, también para leer, y `fin.registrar_comprobante` y
  `fin.anular_comprobante` lo vuelven a verificar en la base. Un usuario sólo de finanzas no
  necesita sedes. Decisión mía, avisada a Fer: la deuda no la ve un operador.
- **Comprobante** (`fin.comprobante`): factura, nota de crédito o de débito, letra A/B/C/M, renglón por
  renglón (decisión de Fer) con producto opcional, precio neto, descuento y alícuota; más percepciones
  e impuestos. Vinculado a compras recibidas **sólo como referencia**, sin control de importes
  (decisión de Fer). La razón social es **responsable inscripta**: A y M discriminan IVA; en B y C la
  base no admite alícuota. El IVA se calcula por alícuota sobre el neto sumado (como la factura), en
  la base, también para la vista previa (`/fin/comprobantes/calcular`). Se carga el total impreso:
  hasta $1 de diferencia se guarda como redondeo; más, no se registra.
- Borrador → registrado → anulado. Registrado no se edita: se anula (movimiento inverso) y se recarga,
  o se hace nota de crédito. No se anula una factura con notas registradas asociadas. Mismo número,
  mismo proveedor: no se carga dos veces (salvo que el anterior esté anulado).
- **Cuenta corriente** = libro mayor inmutable `fin.movimiento_cc` (haber: lo que se debe; debe: lo que
  lo baja). El saldo se deriva (`fin.saldo_proveedor`), como el stock. `fin.comprobante_pendiente`:
  hasta la fase 3, pendiente = total menos notas de crédito asociadas.
- **CUIT** validado con dígito verificador en la base y guardado sin guiones; único entre proveedores.
  Factura A exige CUIT del proveedor. Proveedor con condición IVA y plazo de pago (propone vencimiento).
  Producto con **alícuota habitual** (21 por defecto; 10,5 para carnes, frutas, verduras, harinas).
- **Libro IVA compras** del mes en CSV (`;` y coma decimal, con BOM), notas de crédito en negativo.
- Sin importación de ARCA por ahora (decisión de Fer). Moneda: sólo pesos.
- El cliente manda cuerpo JSON en toda modificación (también DELETE): el servidor exige JSON contra
  CSRF y un DELETE sin cuerpo no lleva tipo de contenido. Estaba roto desde la fase 0.

### Tesorería (fase 3, 21/10/2026)
- **Cuentas** (`fin.cuenta`): bancos, una caja por sede (decisión de Fer) y una sola cartera de cheques
  de terceros. **Saldo derivado** de `fin.movimiento_tes`, libro mayor inmutable; todo insert exige
  permiso de finanzas en la base (`fin.movimiento_tes_firma`). Movimientos manuales (ingreso/egreso con
  concepto obligatorio), transferencias (dos patas, se anulan juntas) y **arqueo de caja** por diferencia
  (`fin.arquear`, como el conteo de stock).
- **Orden de pago** (`fin.orden_pago`, `OP-000001`): aplica a facturas y notas de débito pendientes
  (total o parcial) y puede usar notas de crédito sin factura asociada (`fin.credito_pendiente`).
  **Retenciones cargadas a mano** con certificado (decisión de Fer: sin cálculo de escalas ni padrones).
  Valores: transferencia (banco), efectivo (caja), cheque propio o e-cheq (banco), cheque de tercero
  de la cartera (se endosa entero). Lo que sobra sobre lo aplicado queda **a cuenta**.
  `fin.registrar_orden_pago` valida contra lo pendiente con lock por proveedor, mueve tesorería,
  emite o endosa cheques y baja la deuda por el **bruto** (valores + retenciones).
  `fin.anular_orden_pago` revierte todo; no se puede si un cheque propio ya se debitó. Una factura con
  pagos registrados no se anula. Los números de OP pueden tener huecos (un borrador borrado consume
  el suyo).
- **Cheques** (`fin.cheque`): propio emitido → debitado (recién ahí sale del banco; el saldo proyectado
  lo descuenta antes); tercero en cartera → endosado o depositado. CUIT del librador validado.
- **Conciliación**: extracto en **CSV** (sin Excel: la librería usual de npm tiene vulnerabilidades),
  mapeo de columnas en el navegador, importes y fechas normalizados en el servidor (el separador
  decimal lo dice el usuario). `fin.extracto_linea` con clave única + `ocurrencia`: reimportar no
  duplica. Pareo sugerido por importe exacto y fecha cercana (±10 días), incluido el débito de cheques
  propios; una línea sin pareo se registra como movimiento desde ahí. `fin.conciliacion` se puede deshacer.
- **Retenciones practicadas** del mes en CSV para el contador.
- Números tipeados: con coma decimal, los puntos son de miles ("41.000,50"); sin coma no se tocan.

### Puntos de venta (fase 4, 21/10/2026)
- Esquema `pos`. Fer: **Fudo y Maxirest**, por **API o archivo según haya**, **ticket por ticket**, y lo que
  no alcanza **queda en negativo**.
- **Fudo por API** (`app/fudo.js`): token en `auth.fu.do/api` (apiKey + apiSecret, 24 h), ventas de
  `api.fu.do/v1alpha1/sales` con `filter[closedAt]`, `include=items.product,payments.paymentMethod`,
  páginas de 500. Requiere plan Pro y habilitar "API Pública General". Su OpenAPI no es del todo
  JSON:API (las relaciones a veces vienen como lista de `{data}`): el adaptador acepta las dos formas.
  **Probado sólo contra un simulador** hecho según la especificación: hay que verificarlo con una cuenta
  real. `FUDO_AUTH_URL` y `FUDO_API_URL` existen para las pruebas. Credenciales cifradas con `crypto.js`.
- **Maxirest no tiene API pública**: va por archivo (sus informes de ventas salen a Excel; se guardan
  como CSV). La importación por archivo sirve para cualquier POS: renglones de venta y pagos, con mapeo
  de columnas que se recuerda por integración (`pos.integracion.mapeo`).
- **Recepción idempotente**: `pos.ticket` único por (integración, id del POS); reimportar no duplica y
  una importación sin tickets nuevos no se guarda.
- **Plato de carta** (`logic.plato`): la receta de venta, lo que consume una porción (insumos o
  elaborados, con merma). `pos.articulo` lo vincula con el artículo del POS, o lo marca sin consumo.
- **Procesar es aparte y en dos partes**: el **consumo** (operación, permiso en la sede) descuenta del
  almacén del local por FEFO sin lotes vencidos, un movimiento `venta` por producto y lote (no por
  ticket), y lo que falta va en negativo: en el último lote conocido si es perecedero, sin lote si no.
  Un perecedero que nunca tuvo lote frena el proceso. Los **cobros** (finanzas) entran por cuenta y por
  día a la cuenta de cada medio (`pos.medio.cuenta_id`): efectivo a la caja del local, tarjetas y QR
  a una cuenta de tipo **cobranza**, que pasa al banco con una transferencia cuando se acredita.
- Anular una importación revierte consumo y cobros y borra sus tickets para reimportar. Con cobros
  procesados, la anula finanzas. Finanzas ve las integraciones de todos los locales.
- Pendiente: sincronización automática programada (hoy es a pedido), modificadores de Fudo
  (subitems), propinas.

### Tablero (fase 5, 21/10/2026)
- **No guarda nada**: `logic.kardex` abre cada movimiento en una fila por punta (sede, signo, costo) y
  `logic.kardex_concepto` le pone para qué sirvió: teórico (ventas del POS), pérdida (merma, vencimiento),
  diferencia (ajustes de conteo y sobrantes de remito), consumo interno, venta manual, producción, compra,
  transferencia (remito entre sedes) e interno. Las anulaciones se cancelan solas al sumar.
- **Valorización**: al costo del lote; lo que no tiene lote, al costo vigente de hoy (aproximación, avisada
  en pantalla). Lo que no tiene costo no suma y se cuenta aparte.
- **Food cost** sobre ventas netas: las ventas del POS se toman con IVA incluido (21% por defecto, se
  cambia en la pantalla). Real = teórico + pérdida + diferencia + consumo interno + venta manual. Por
  producto, dónde está el desvío; por plato, costo de la porción con costo vigente, food cost y margen.
- **Flujo de caja** (sólo finanzas): entradas y salidas por semana desde `fin.movimiento_tes` (sin
  transferencias ni depósitos de cheques, que no son flujo) y saldo proyectado a 8 semanas: disponible
  (bancos + cajas) menos lo vencido, menos facturas por vencimiento y cheques propios por fecha de pago,
  más cheques de terceros en cartera. No proyecta ventas futuras.
- Lo ve el encargado (sus sedes), finanzas y el administrador (todas). `app/tablero.js`, `tablero.html`;
  gráficos en SVG propio, paleta validada para claro y oscuro, con tabla al lado de cada uno.

### Lo que hay y lo que falta
Hay: panel, stock y conteos, movimientos (histórico, egresos, traslados, anulación), compras con
recepción y decisión de costo, recetas, producción con FEFO, trazabilidad por lote, frío,
productos (SKU y GTIN), etiquetas A4 con QR Digital Link y EAN-13, almacenes, proveedores y unidades,
login con roles por sede, PIN en tablet de cocina, Mi cuenta y administración de usuarios,
sedes, notas de pedido, remitos internos y unidades productivas, comprobantes de proveedor,
cuenta corriente, libro IVA compras, órdenes de pago, tesorería, cheques, conciliación bancaria,
platos de carta, integración con POS (Fudo por API, archivo para cualquiera), consumo teórico y tablero
(food cost, teórico contra real, rentabilidad por plato, flujo de caja).
Lectura de códigos con lector USB/Bluetooth o cámara en productos, compras, conteos y egresos. API en `app/*.js` (helpers comunes en `app/util.js`); pantallas
en `app/public/` con estilos y helpers compartidos en `comun.css` y `comun.js`.

**Interfaz.** `comun.js` arma la navegación de todas las pantallas: barra lateral agrupada desde
900 px; en el celular, barra inferior (Panel, Stock, Escanear, Productos, Más). **Escanear** es
global: producto abre su ficha, lote su trazabilidad, código desconocido va al alta
(`productos.html#nuevo/<gtin>`). Productos usa rutas en el `#` (`#p/<id>`, `#nuevo`) para que en
el celular listado y ficha sean pantallas separadas con el botón atrás funcionando. Tipografía
Archivo servida desde el paquete npm (`/vendor/archivo`), nunca de Google Fonts. Campos a 16 px en
el celular: con menos, el iPhone hace zoom al tocarlos.

Falta: recepción parcial de compras, anular una compra recibida o una
producción entera, mínimos por sede, lectura de sensores de temperatura, importación de ARCA,
extractos en Excel, cheques de terceros rechazados, sincronización automática de POS, y costeo histórico de los no perecederos (hoy van a costo vigente).

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
