"""Sirve app/public con la API simulada y saca capturas. Uso: python3 -I ver.py <public> <node_modules> <salida> pagina[:tema[:ancho]] ..."""
import sys, json, http.server, threading, functools, os
from playwright.sync_api import sync_playwright

pub, nm, out = sys.argv[1:4]
paginas = sys.argv[4:]

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def translate_path(self, path):
        path = path.split('?')[0]
        if path.startswith('/vendor/plex/'):
            return os.path.join(nm, '@fontsource-variable/ibm-plex-sans/files', path[len('/vendor/plex/'):])
        return os.path.join(pub, path.lstrip('/') or 'index.html')

srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:%d/' % srv.server_address[1]
SES = {'usuario': {'id': 1, 'usuario': 'fer', 'nombre': 'Fernando Mayorano', 'es_admin': True, 'finanzas': True, 'roles': [],
                   'puede': {'finanzas': True, 'catalogo': True, 'gestionar': True, 'admin': True, 'proveedor': True}}, 'dispositivo': None}

def api(route):
    u = route.request.url
    if '/api/sesion' in u:
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(SES, ok=True)))
    v = [5.9, 3.6, 2.4, 2.0, 3.2, 4.3, 5.4, 6.1, 3.7, 2.5, 2.2, 3.4, 4.6]
    dias = [{'dia': '2026-11-%02d' % (i + 1), 'vendido': str(x * 1e6), 'neto': str((x - 3.4) * 4e5)} for i, x in enumerate(v)]
    datos = {}
    if 'pos/ventas/resumen' in u:
        datos = {'totales': {'vendido': '49300000'}, 'dias': dias, 'anterior': {'totales': {'vendido': '44100000'}}}
    elif 'fin/tesoreria/tablero' in u:
        datos = {'saldo_inicial': '16200000', 'saldo_final': '18420000', 'entradas': '41200000', 'salidas': '38980000', 'dias': dias}
    elif 'tablero/operativo' in u:
        datos = {'sedes': [{'ventas_netas': '40700000', 'real': '13900000', 'teorico': '12600000'}]}
    elif 'fin/pagos-sin-factura' in u:
        datos = {'recortado': False, 'pagos': [
            {'id': 1, 'fecha': '2026-11-11', 'importe': '1752771.00', 'disponible': '1752771.00', 'aplicado': '0', 'concepto': 'PILOTTI SA EMPRESA FRIGORIFICA', 'destinatario': None, 'rubro': 'Mercadería · Carnes', 'cuenta': 'BRUBANK', 'sociedad': 'CORTAFUEGO SRL', 'sociedad_id': 'x'},
            {'id': 2, 'fecha': '2026-11-04', 'importe': '920216.00', 'disponible': '420216.00', 'aplicado': '500000.00', 'concepto': 'Transferencia enviada', 'destinatario': 'Consorcio Av. Libertador 1200', 'rubro': 'Expensas', 'cuenta': 'MERCADO PAGO SORE', 'sociedad': 'SORELLE CIUCIO SA', 'sociedad_id': 'y'}]}
    elif 'api/sociedades' in u:
        datos = {'sociedades': [{'id': 'x', 'nombre': 'CORTAFUEGO SRL', 'activa': True}, {'id': 'y', 'nombre': 'SORELLE CIUCIO SA', 'activa': True}]}
    elif 'fin/cuentas' in u:
        datos = {'cuentas': [{'id': 'b1', 'nombre': 'BRUBANK', 'tipo': 'banco', 'activa': True}, {'id': 'b2', 'nombre': 'MERCADO PAGO SORE', 'tipo': 'banco', 'activa': True}]}
    elif 'fin/conciliacion?' in u:
        b1 = 'cuenta=b1' in u
        datos = {'extractos': [{'id': 1}], 'cobros': [], 'sugerencias': [], 'transferencias': [], 'descartadas': [], 'lineas': (
            [{'id': 11, 'fecha': '2026-10-30', 'importe': '-326000.00', 'concepto': 'HUDSON BOHNCOC SRL', 'destinatario': None, 'candidatos': [], 'lado': 'egresos'},
             {'id': 12, 'fecha': '2026-11-13', 'importe': '-2615608.67', 'concepto': 'ARCA Vep', 'destinatario': None, 'candidatos': [], 'lado': 'egresos'}] if b1 else
            [{'id': 21, 'fecha': '2026-10-16', 'importe': '-187175.14', 'concepto': 'Pago desde Mercado Pago - 184476250362', 'destinatario': 'Transferencia enviada TRANSVE SA', 'candidatos': [], 'lado': 'egresos'}])}
    elif 'fin/rubros' in u:
        datos = {'rubros': [{'id': 'r1', 'nombre': 'Mercadería · Almacén', 'linea': 'cmv', 'activo': True, 'del_centro': True}, {'id': 'r2', 'nombre': 'Ingresos Brutos', 'linea': 'impuestos', 'activo': True, 'del_centro': False}]}
    elif 'api/sedes' in u:
        datos = {'sedes': [{'id': 's0', 'nombre': 'CF CENTRAL', 'activa': True, 'es_central': True}, {'id': 's1', 'nombre': 'CORTAFUEGO PARRILLA', 'activa': True, 'es_central': False}]}
    elif 'fin/proveedores/resumen' in u:
        datos = {'proveedores': [{'id': 'p1', 'saldo': '0', 'ultimo': '2026-11-11', 'comprobantes': 18, 'comprado_30': '12450000', 'vencido': '0'},
                                 {'id': 'p2', 'saldo': '742500', 'ultimo': '2026-11-12', 'comprobantes': 4, 'comprado_30': '1604500', 'vencido': '386000'},
                                 {'id': 'p3', 'saldo': '0', 'ultimo': '2026-11-06', 'comprobantes': 5, 'comprado_30': '370000', 'vencido': '0'}]}
    elif 'fin/cuenta-corriente/' in u:
        datos = {'proveedor': {}, 'pendientes': [], 'movimientos': [
            {'id': 1, 'fecha': '2026-10-24', 'tipo': 'factura', 'comprobante_id': 'c1', 'haber': '1256000.00', 'debe': '0', 'detalle': 'FC X 00000-00000002', 'sociedad': 'CORTAFUEGO SRL', 'saldo': '1256000', 'anula_a': None},
            {'id': 2, 'fecha': '2026-10-24', 'tipo': 'pago', 'comprobante_id': 'c1', 'haber': '0', 'debe': '1256000.00', 'detalle': 'Pagado con Fudo pago #2120 · Almacén · PECSE PESCADERIA (CAJA MAYOR EFECTIVO, 24/10/2026)', 'sociedad': 'CORTAFUEGO SRL', 'saldo': '0', 'anula_a': None}]}
    elif 'api/proveedores' in u:
        datos = {'proveedores': [{'id': 'p1', 'nombre': 'Frigorifico Pilotti', 'cuit': '30712345678', 'condicion_iva': 'responsable_inscripto', 'contacto': 'Marcelo', 'telefono': '11 4455-6677', 'activo': True, 'plazo_pago_dias': 15},
                                 {'id': 'p2', 'nombre': 'Coca Cola', 'cuit': None, 'condicion_iva': None, 'contacto': None, 'telefono': None, 'activo': True},
                                 {'id': 'p3', 'nombre': 'Pecse Pescaderia', 'cuit': None, 'condicion_iva': None, 'contacto': None, 'telefono': None, 'activo': True, 'notas': 'Creado desde los pagos sin factura'}]}
    elif 'pos/cierre' in u:
        def d(dia, ventas=12, **k): return dict({'dia': dia, 'ventas': ventas, 'sincronizado': True, 'efectivo': '0', 'vendido': '1000', 'cobrado': '1000'}, **k)
        hoy_c = '2026-11-15T08:02:00Z'
        datos = {'puntos': [
            {'id': 'i1', 'sede': 'CORTAFUEGO PARRILLA', 'nombre': 'CORTAFUEGO PARRILLA', 'sistema': 'fudo', 'modo': 'api', 'sincroniza_auto': True, 'efectivo_a_rendir': '0', 'cuenta_efectivo_id': 'e1',
             'ultima_corrida': {'ok': True, 'automatica': True, 'iniciada_en': hoy_c, 'terminada_en': hoy_c}, 'tareas': [], 'dias': [d('2026-11-14')]},
            {'id': 'i2', 'sede': 'SORELLE BODEGON Y SUSHI', 'nombre': 'SORELLE BODEGON Y SUSHI', 'sistema': 'maxirest', 'modo': 'api', 'sincroniza_auto': False, 'efectivo_a_rendir': '412000', 'cuenta_efectivo_id': 'e2',
             'traer_desde': '2026-11-13', 'ultima_corrida': {'ok': True, 'automatica': False, 'iniciada_en': '2026-11-13T10:00:00Z'},
             'tareas': [{'tipo': 'corrida', 'nivel': 'aviso', 'texto': 'Faltan traer las ventas desde el 13/11.'}, {'tipo': 'efectivo', 'nivel': 'aviso', 'texto': 'Efectivo a rendir de 2 día(s).', 'desde': '2026-11-11'}],
             'dias': [d('2026-11-14', 0, sincronizado=False), d('2026-11-13', 0, sincronizado=False), d('2026-11-12', efectivo='200000')]},
            {'id': 'i3', 'sede': 'SORELLE CAFETERIA', 'nombre': 'SORELLE CAFETERIA', 'sistema': 'maxirest', 'modo': 'api', 'sincroniza_auto': False, 'efectivo_a_rendir': '0', 'cuenta_efectivo_id': 'e3',
             'ultima_corrida': {'ok': True, 'automatica': False, 'iniciada_en': '2026-11-15T10:59:00Z', 'terminada_en': '2026-11-15T10:59:20Z'},
             'tareas': [{'tipo': 'dia', 'clase': 'medios', 'nivel': 'mal', 'dias': ['2026-11-14'], 'texto': 'Hay cobros con un medio sin asignar.'}], 'dias': [d('2026-11-14')]},
            {'id': 'i4', 'sede': 'CORTAFUEGO PARRILLA', 'nombre': 'PedidosYa · CORTAFUEGO PARRILLA', 'sistema': 'pedidosya', 'modo': 'archivo', 'sincroniza_auto': False, 'efectivo_a_rendir': '0',
             'ultima_corrida': None, 'tareas': [{'tipo': 'importar', 'nivel': 'aviso', 'dias': ['2026-11-14'], 'texto': 'Faltan importar las ventas de 1 día(s).'}],
             'dias': [d('2026-11-14', 0, sincronizado=False), d('2026-11-13')]},
            {'id': 'i5', 'sede': 'SORELLE BODEGON Y SUSHI', 'nombre': 'PedidosYa · SORELLE BODEGON Y SUSHI', 'sistema': 'pedidosya', 'modo': 'archivo', 'sincroniza_auto': False, 'efectivo_a_rendir': '0',
             'ultima_corrida': None, 'tareas': [], 'dias': [d('2026-11-14')]}]}
    elif 'fin/procesadores/resumen' in u:
        datos = {'procesadores': [
            {'nombre': 'MERCADO PAGO SORELLE', 'marca': 'mercadopago', 'cuenta_id': 'c1', 'cuenta': 'MERCADO PAGO SORE', 'ventas': {'hasta': '2026-11-14', 'puntos': [{'sede': 'x', 'ultimo': '2026-11-14'}]},
             'resumen': {'extracto': {'hasta': '2026-11-13', 'lineas_ingresos': 3, 'lineas_egresos': 17}}},
            {'nombre': 'Fudo Pagos', 'marca': 'fudo', 'cuenta_id': 'c2', 'cuenta': 'BRUBANK', 'ventas': {'hasta': '2026-11-14', 'puntos': [{'sede': 'x', 'ultimo': '2026-11-14'}]},
             'resumen': {'extracto': {'hasta': '2026-11-14', 'lineas_ingresos': 0, 'lineas_egresos': 4}}},
            {'nombre': 'PAGO24 CORTAFUEGO', 'marca': 'pago24', 'portal': True, 'cuenta_id': 'c3', 'cuenta': 'PAGO 24 - 210973', 'ventas': {'hasta': '2026-11-14', 'puntos': [{'sede': 'x', 'ultimo': '2026-11-14'}]},
             'resumen': {'extracto': {'hasta': '2026-11-14', 'lineas_ingresos': 0, 'lineas_egresos': 0}}}]}
    elif 'abastecimiento/pendientes' in u:
        datos = {'pendientes': [{'etapa': 'Por pagar', 'proveedor': 'Logistica La Serenisima', 'compra_id': 'k1', 'paso': 'pago', 'importe': '426198', 'vencimiento': '2026-11-12', 'fecha': '2026-11-10'},
                                {'etapa': 'Esperando mercadería', 'proveedor': 'Disval', 'compra_id': 'k2', 'paso': 'recepcion', 'fecha': '2026-11-14'}]}
    elif 'stock/productos' in u: datos = {'productos': []}
    elif 'api/stock' in u: datos = {'stock': []}
    elif 'api/frio' in u: datos = {'equipos': []}
    elif 'api/compras' in u: datos = {'compras': []}
    elif 'fin/resultados' in u:
        ant = 'desde=2026-10' in u
        datos = {'rubros': [{'linea': 'ventas', 'importe': '44100000' if ant else '49300000'}, {'linea': 'cmv', 'importe': '-17756000'},
                            {'linea': 'personal', 'importe': '-10422000'}, {'linea': 'locacion', 'importe': '-4246000'}, {'linea': 'impuestos', 'importe': '-6176000'}]}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(datos, ok=True)))

with sync_playwright() as p:
    b = p.chromium.launch()
    for spec in paginas:
        partes = spec.split(':')
        pag, tema, ancho = partes[0], (partes[1] if len(partes) > 1 else 'dark'), int(partes[2]) if len(partes) > 2 else 1440
        ctx = b.new_context(viewport={'width': ancho, 'height': 900}, color_scheme=tema, device_scale_factor=1)
        page = ctx.new_page()
        errores = []
        page.on('pageerror', lambda e: errores.append(str(e)[:200]))
        page.route('**/api/**', api)
        page.goto(base + pag, wait_until='networkidle')
        page.wait_for_timeout(400)
        nombre = '%s/%s-%s-%d.png' % (out, pag.split('.')[0].split('#')[0], tema, ancho)
        clic = partes[3] if len(partes) > 3 else None
        if clic and clic.startswith('='):
            for t in clic[1:].split('+'):
                page.get_by_role('button', name=t).first.click()
                page.wait_for_timeout(300)
            nombre = nombre.replace('.png', '-%s.png' % clic[1:].replace(' ', '_').replace('+', '_'))
            clic = None
            page.screenshot(path=nombre, full_page=True)
            print(nombre, 'errores:', errores[:3]); ctx.close(); continue
        if clic:
            page.locator('.inferior button', has_text=clic).click()
            page.wait_for_timeout(300)
            nombre = nombre.replace('.png', '-%s.png' % clic)
        page.screenshot(path=nombre, full_page=not clic)
        print(nombre, 'errores:', errores[:3])
        ctx.close()
    b.close()
