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
        if clic:
            page.locator('.inferior button', has_text=clic).click()
            page.wait_for_timeout(300)
            nombre = nombre.replace('.png', '-%s.png' % clic)
        page.screenshot(path=nombre, full_page=not clic)
        print(nombre, 'errores:', errores[:3])
        ctx.close()
    b.close()
