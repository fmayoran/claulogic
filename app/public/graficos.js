// Gráficos de los tableros, en SVG propio (sin librerías): área con comparación, columnas, dona, mini curva y
// ranking. Cada uno se dibuja al ancho real de su caja (el texto queda a 12 px de verdad) y se redibuja si cambia.
// Los colores salen de variables CSS por rol (graficos.css), validadas para claro y oscuro: --serie-1..6 en orden
// fijo, --anterior para el período de comparación. Los valores llegan como texto exacto de la base; Number sólo
// para la geometría.
const Graf = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const n = v => v == null || v === '' ? 0 : Number(v);
  const compacto = v => {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    return s + (a >= 1e6 ? '$' + (a / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M'
      : a >= 1e3 ? '$' + (a / 1e3).toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' mil' : '$' + a.toLocaleString('es-AR', { maximumFractionDigits: 0 }));
  };
  // Escala con números redondos: el tope y en cuántas marcas se divide.
  function escala(max) {
    if (max <= 0) return [1, 4];
    const paso = Math.pow(10, Math.floor(Math.log10(max))), m = max / paso;
    const k = m <= 1 ? 1 : m <= 1.5 ? 1.5 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 5 ? 5 : m <= 7.5 ? 7.5 : 10;
    return [k * paso, [1.5, 3, 7.5].includes(k) ? 3 : k === 5 ? 5 : 4];
  }
  const dibujos = new Map();
  let _rz; addEventListener('resize', () => { clearTimeout(_rz); _rz = setTimeout(() => dibujos.forEach(fn => fn()), 150); });
  const dibujar = (cont, fn) => { dibujos.set(cont, fn); fn(); };
  const ancho = cont => Math.max(240, cont.clientWidth);

  // Tooltip dentro de la caja del gráfico.
  function tip(cont) {
    cont.style.position = 'relative';
    const t = el('div', { className: 'g-tip', hidden: true }); cont.append(t);
    return {
      mostrar(x, y, titulo, filas) {
        t.replaceChildren(el('b', { textContent: titulo }), ...filas.map(([color, txt, punteada]) => el('div', {},
          color ? el('i', { className: punteada ? 'punteada' : '', style: `--c:var(${color})` }) : '', txt)));
        t.hidden = false;
        const w = cont.clientWidth;
        t.style.left = Math.max(0, Math.min(x + 14, w - t.offsetWidth - 2)) + 'px';
        t.style.top = Math.max(0, y - t.offsetHeight - 12) + 'px';
      },
      ocultar() { t.hidden = true; },
    };
  }
  const pos = (cont, ev) => { const r = cont.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

  // Mini curva de tendencia (sin ejes), para las cifras. Un solo valor no dibuja nada.
  function mini(cont, valores, color = '--serie-1') {
    dibujar(cont, () => {
      cont.replaceChildren();
      const vs = valores.map(n); if (vs.length < 2) return;
      const w = ancho(cont), h = 36, max = Math.max(...vs, 1), min = Math.min(...vs, 0);
      const x = i => 2 + (w - 4) * i / (vs.length - 1), y = v => h - 3 - (h - 6) * (v - min) / (max - min || 1);
      const d = vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', class: 'g-mini' });
      svg.append(svgEl('path', { d: `${d} L${x(vs.length - 1)} ${h} L${x(0)} ${h} Z`, class: 'relleno', style: `fill:var(${color})` }),
        svgEl('path', { d, class: 'linea', style: `stroke:var(${color})` }));
      cont.append(svg);
    });
  }

  // Área de una serie con, opcionalmente, la del período anterior punteada para comparar. Cruz y tooltip al pasar;
  // tocar un punto llama a alElegir(i).
  function area(cont, { etiquetas, ejeX = e => e, titulo = e => e, serie, anterior, fmt = compacto, alElegir, elegido = null, alto = 240 }) {
    dibujar(cont, () => {
      cont.replaceChildren();
      if (!etiquetas.length) return cont.append(el('p', { className: 'g-vacio', textContent: 'Sin datos en el período.' }));
      const w = ancho(cont), izq = 52, der = 8, arriba = 10, abajo = 26, H = alto - arriba - abajo;
      const vs = serie.valores.map(n), va = anterior ? anterior.valores.map(n) : [];
      const [tope, div] = escala(Math.max(...vs, ...va, 0));
      const uno = etiquetas.length === 1;
      const x = i => uno ? izq + (w - izq - der) / 2 : izq + (w - izq - der) * i / (etiquetas.length - 1);
      const y = v => arriba + H - H * v / tope;
      const svg = svgEl('svg', { viewBox: `0 0 ${w} ${alto}`, role: 'img', 'aria-label': serie.nombre, class: 'g-svg' });
      for (let k = 0; k <= div; k++) {
        const v = tope * k / div;
        svg.append(svgEl('line', { x1: izq, x2: w - der, y1: y(v), y2: y(v), class: k ? 'grilla' : 'base' }));
        const t = svgEl('text', { x: izq - 8, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = fmt(v); svg.append(t);
      }
      const camino = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      if (anterior && va.length) svg.append(svgEl('path', { d: camino(va.slice(0, etiquetas.length)), class: 'linea anterior' }));
      if (!uno) {
        const grad = 'g' + Math.random().toString(36).slice(2, 8);
        const defs = svgEl('defs'), lg = svgEl('linearGradient', { id: grad, x1: 0, y1: 0, x2: 0, y2: 1 });
        lg.append(svgEl('stop', { offset: '0%', style: 'stop-color:var(--serie-1);stop-opacity:.22' }), svgEl('stop', { offset: '100%', style: 'stop-color:var(--serie-1);stop-opacity:0' }));
        defs.append(lg); svg.append(defs);
        svg.append(svgEl('path', { d: `${camino(vs)} L${x(vs.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`, fill: `url(#${grad})` }));
        svg.append(svgEl('path', { d: camino(vs), class: 'linea', style: 'stroke:var(--serie-1)' }));
      }
      // Etiquetas del eje x sin pisarse.
      const cada = Math.ceil(etiquetas.length / Math.max(1, Math.floor((w - izq) / 56)));
      etiquetas.forEach((e, i) => { if (i % cada === 0 || i === etiquetas.length - 1 && (etiquetas.length - 1) % cada > cada / 2) {
        const t = svgEl('text', { x: x(i), y: alto - 6, 'text-anchor': 'middle' }); t.textContent = ejeX(e); svg.append(t); } });
      // El punto elegido (el que filtra el detalle) queda marcado.
      if (elegido != null && elegido >= 0) svg.append(svgEl('line', { x1: x(elegido), x2: x(elegido), y1: arriba, y2: arriba + H, class: 'marca' }),
        svgEl('circle', { cx: x(elegido), cy: y(vs[elegido]), r: 5.5, class: 'punto elegido' }));
      const cruz = svgEl('line', { y1: arriba, y2: arriba + H, class: 'cruz', visibility: 'hidden' });
      const punto = svgEl('circle', { r: 5, class: 'punto', visibility: 'hidden' });
      svg.append(cruz, punto);
      if (uno) svg.append(svgEl('circle', { cx: x(0), cy: y(vs[0]), r: 5, class: 'punto' }));
      const tp = tip(cont);
      const zona = svgEl('rect', { x: izq, y: 0, width: w - izq - der, height: alto - abajo, class: 'g-zona' + (alElegir ? ' clic' : '') });
      const indice = ev => { const [px] = pos(cont, ev); return uno ? 0 : Math.max(0, Math.min(etiquetas.length - 1, Math.round((px - izq) / (w - izq - der) * (etiquetas.length - 1)))); };
      zona.addEventListener('pointermove', ev => {
        const i = indice(ev);
        cruz.setAttribute('x1', x(i)); cruz.setAttribute('x2', x(i)); cruz.setAttribute('visibility', 'visible');
        punto.setAttribute('cx', x(i)); punto.setAttribute('cy', y(vs[i])); punto.setAttribute('visibility', 'visible');
        const filas = [['--serie-1', `${serie.nombre}: ${serie.texto ? serie.texto(i) : fmt(vs[i])}`]];
        if (anterior && i < va.length) filas.push(['--anterior', `${anterior.nombre}: ${anterior.texto ? anterior.texto(i) : fmt(va[i])}`, true]);
        tp.mostrar(x(i), y(vs[i]), titulo(etiquetas[i], i), filas);
      });
      zona.addEventListener('pointerleave', () => { cruz.setAttribute('visibility', 'hidden'); punto.setAttribute('visibility', 'hidden'); tp.ocultar(); });
      if (alElegir) zona.addEventListener('click', ev => alElegir(indice(ev)));
      svg.append(zona);
      cont.prepend(svg);
    });
  }

  // Columnas de una serie; la elegida resaltada y el resto atenuado.
  function columnas(cont, { etiquetas, valores, ejeX = e => e, titulo = e => e, texto, fmt = compacto, alElegir, elegido = null, alto = 200 }) {
    dibujar(cont, () => {
      cont.replaceChildren();
      if (!etiquetas.length) return cont.append(el('p', { className: 'g-vacio', textContent: 'Sin datos en el período.' }));
      const w = ancho(cont), izq = 52, arriba = 8, abajo = 26, H = alto - arriba - abajo, vs = valores.map(n);
      const [tope, div] = escala(Math.max(...vs, 0)), y = v => arriba + H - H * v / tope;
      const banda = (w - izq) / etiquetas.length, col = Math.max(4, Math.min(28, banda * .62));
      const svg = svgEl('svg', { viewBox: `0 0 ${w} ${alto}`, role: 'img', class: 'g-svg' });
      for (let k = 0; k <= div; k++) {
        const v = tope * k / div;
        svg.append(svgEl('line', { x1: izq, x2: w, y1: y(v), y2: y(v), class: k ? 'grilla' : 'base' }));
        const t = svgEl('text', { x: izq - 8, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = fmt(v); svg.append(t);
      }
      const tp = tip(cont), cada = Math.ceil(etiquetas.length / Math.max(1, Math.floor((w - izq) / 40)));
      etiquetas.forEach((e, i) => {
        const cx = izq + banda * i + banda / 2, v = vs[i];
        if (v > 0) {
          const x0 = cx - col / 2, yt = y(v), b = y(0), r = Math.min(4, (b - yt) / 2, col / 2);
          svg.append(svgEl('path', { d: `M${x0} ${b} V${yt + r} Q${x0} ${yt} ${x0 + r} ${yt} H${x0 + col - r} Q${x0 + col} ${yt} ${x0 + col} ${yt + r} V${b} Z`,
            class: 'barra' + (elegido != null && elegido !== i ? ' atenuada' : ''), style: 'fill:var(--serie-1)' }));
        }
        if (i % cada === 0) { const t = svgEl('text', { x: cx, y: alto - 6, 'text-anchor': 'middle' }); t.textContent = ejeX(e); svg.append(t); }
        const zona = svgEl('rect', { x: cx - banda / 2, y: 0, width: banda, height: alto - abajo, class: 'g-zona barra-zona' + (alElegir ? ' clic' : '') });
        zona.addEventListener('pointermove', ev => { const [px] = pos(cont, ev); tp.mostrar(px, y(v), titulo(e, i), [['--serie-1', texto ? texto(i) : fmt(v)]]); });
        zona.addEventListener('pointerleave', () => tp.ocultar());
        if (alElegir) zona.addEventListener('click', () => alElegir(i));
        svg.insertBefore(zona, svg.firstChild);
      });
      cont.prepend(svg);
    });
  }

  // Dona con el total en el centro y su leyenda al lado: cada parte con su color (orden fijo, hasta 6; el resto
  // se junta en "Otros"), su porcentaje e importe. Tocar una parte o su renglón llama a alElegir(clave).
  function dona(cont, { items, centro, sub, fmt = v => pesos(String(v)), alElegir, elegido = null, maximo = 6 }) {
    let partes = items.filter(it => n(it.valor) > 0);
    if (partes.length > maximo) {
      const resto = partes.slice(maximo - 1);
      partes = [...partes.slice(0, maximo - 1), { clave: null, etiqueta: `Otros (${resto.length})`, valor: resto.reduce((s, it) => s + n(it.valor), 0) }];
    }
    const total = partes.reduce((s, it) => s + n(it.valor), 0);
    cont.replaceChildren();
    if (!total) return cont.append(el('p', { className: 'g-vacio', textContent: 'Sin datos en el período.' }));
    const R = 80, r = 56, c = 90, svg = svgEl('svg', { viewBox: '0 0 180 180', role: 'img', class: 'g-dona' });
    let ang = -Math.PI / 2;
    const tp = tip(cont);
    const arco = (a0, a1) => {
      const g = Math.min(a1 - a0, Math.PI * 2 - 1e-4), a1b = a0 + g, grande = g > Math.PI ? 1 : 0;
      const p = (rad, a) => `${(c + rad * Math.cos(a)).toFixed(2)} ${(c + rad * Math.sin(a)).toFixed(2)}`;
      return `M${p(R, a0)} A${R} ${R} 0 ${grande} 1 ${p(R, a1b)} L${p(r, a1b)} A${r} ${r} 0 ${grande} 0 ${p(r, a0)} Z`;
    };
    const filas = partes.map((it, i) => {
      const v = n(it.valor), a = v / total * Math.PI * 2, color = `--serie-${i + 1}`;
      const sel = elegido != null && it.clave === elegido, apagada = elegido != null && !sel;
      const path = svgEl('path', { d: arco(ang, ang + a), class: 'parte' + (apagada ? ' atenuada' : '') + (alElegir && it.clave ? ' clic' : ''), style: `fill:var(${color})` });
      ang += a;
      const pct = (v / total * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
      path.addEventListener('pointermove', ev => { const [px, py] = pos(cont, ev); tp.mostrar(px, py, it.etiqueta, [[color, `${fmt(it.valor)} · ${pct}`]]); });
      path.addEventListener('pointerleave', () => tp.ocultar());
      if (alElegir && it.clave) path.addEventListener('click', () => alElegir(it.clave));
      svg.append(path);
      const b = el('button', { type: 'button', className: 'g-ley' + (sel ? ' act' : '') + (apagada ? ' atenuada' : ''), disabled: !(alElegir && it.clave) },
        el('i', { style: `--c:var(${color})` }), el('span', { className: 'n' }, it.etiqueta, it.marca || ''),
        el('span', { className: 'v', textContent: fmt(it.valor) }), el('span', { className: 'p', textContent: pct }));
      if (alElegir && it.clave) b.onclick = () => alElegir(it.clave);
      return b;
    });
    const tc = svgEl('text', { x: c, y: c + 2, 'text-anchor': 'middle', class: 'centro' }); tc.textContent = centro ?? fmt(total);
    const ts = svgEl('text', { x: c, y: c + 20, 'text-anchor': 'middle', class: 'centro-sub' }); ts.textContent = sub || 'total';
    svg.append(tc, ts);
    cont.append(el('div', { className: 'g-dona-caja' }, svg, el('div', { className: 'g-leyenda' }, ...filas)));
  }

  // Ranking en barras horizontales (HTML): nombre, barra proporcional al mayor y valor.
  function ranking(cont, { items, fmt = v => pesos(String(v)), nota, alElegir, elegido = null }) {
    const max = Math.max(...items.map(it => n(it.valor)), 0);
    cont.replaceChildren(...items.map(it => {
      const b = el('button', { type: 'button', className: 'g-rank' + (elegido != null && it.clave === elegido ? ' act' : '') + (elegido != null && it.clave !== elegido ? ' atenuada' : ''), disabled: !alElegir },
        el('span', { className: 'n', textContent: it.etiqueta }), el('span', { className: 'v', textContent: fmt(it.valor) }),
        el('span', { className: 'pista' }, el('i', { style: `width:${max ? (n(it.valor) / max * 100).toFixed(1) : 0}%` })),
        nota ? el('span', { className: 'nota', textContent: nota(it) }) : '');
      if (alElegir) b.onclick = () => alElegir(it.clave);
      return b;
    }));
    if (!items.length) cont.append(el('p', { className: 'g-vacio', textContent: 'Sin datos en el período.' }));
  }

  // Variación contra el período anterior: flecha y texto, nunca sólo el color.
  function variacion(actual, anterior) {
    const a = n(actual), b = n(anterior);
    if (!b) return el('span', { className: 'g-var', textContent: a ? 'sin datos para comparar' : '' });
    const p = (a - b) / b * 100, sube = p > 0.05, baja = p < -0.05;
    return el('span', { className: 'g-var ' + (sube ? 'sube' : baja ? 'baja' : '') },
      el('b', { textContent: (sube ? '▲ ' : baja ? '▼ ' : '= ') + Math.abs(p).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%' }));
  }

  return { mini, area, columnas, dona, ranking, variacion, compacto, escala };
})();
