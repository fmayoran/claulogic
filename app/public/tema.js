// Tema elegido en Mi cuenta ('claro' u 'oscuro'; sin elegir, sigue al dispositivo). Va en el <head>, antes de los estilos,
// para que la pantalla no se pinte primero con el otro tema.
(function () {
  try {
    var t = localStorage.getItem('tema');
    if (t === 'claro' || t === 'oscuro') document.documentElement.dataset.tema = t;
  } catch (e) {}
})();
