#!/usr/bin/env bash
# Despliega ClauLogic en EasyPanel (proyecto `claulogic`, servicio `app`).
#
# ══ LO QUE ESTE SCRIPT HEREDA DE ClaUsina (aprendido a la mala, no lo saques) ═════════════════
#
# 1. EasyPanel construye LO QUE HAY EN GITHUB, no lo que hay en el disco. Un deploy disparado con
#    cambios sin commitear —o commiteados y sin pushear— reconstruye la versión anterior y dice
#    "OK". En ClaUsina pasó: el push falló por la clave SSH, el deploy se disparó igual y la
#    corrección nunca llegó, con el script informando éxito. Se comprueba ANTES de disparar.
#
# 2. "El servicio recreó la tarea" NO es "el servicio corre TU código". Se verifica contra el
#    contenido real de los archivos adentro del contenedor, no contra el estado del servicio.
#
# 3. La API tRPC de EasyPanel exige POST. Con GET devuelve 405 y el script fallaba en silencio,
#    diciendo "desplegado" sin haber desplegado. No volver a GET.
set -euo pipefail

PROJECT="claulogic"
SERVICE="app"
ESPERA_MAX=60          # 60 x 10s = 10 minutos
REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
# Las credenciales de EasyPanel son de INFRA y viven con las de infra, no en el env de la app:
# ClauLogic no tiene por qué poder redeployarse a sí misma desde adentro del contenedor.
ENV_FILE="/root/clausina/.env"

# ── 1. Lo que se va a construir es lo que está en GitHub ─────────────────────────────────────
sucio=$(git -C "$REPO" status --porcelain --untracked-files=no)
if [ -n "$sucio" ]; then
  echo "Hay cambios sin commitear en $REPO. EasyPanel construye desde GitHub, así que NO se" >&2
  echo "desplegarían. Commiteá y pusheá primero:" >&2
  echo "$sucio" | sed 's/^/  /' >&2
  exit 1
fi
git -C "$REPO" fetch -q origin main
LOCAL=$(git -C "$REPO" rev-parse HEAD)
REMOTO=$(git -C "$REPO" rev-parse origin/main)
if [ "$LOCAL" != "$REMOTO" ]; then
  echo "El commit local no está en GitHub (local ${LOCAL:0:7}, origin/main ${REMOTO:0:7})." >&2
  echo "Corré 'git -C $REPO push origin main' y volvé a intentar." >&2
  exit 1
fi
echo "Desplegando ${LOCAL:0:7} — $(git -C "$REPO" log -1 --format=%s)"

EP_URL=$(grep -E '^EASYPANEL_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ' | sed 's:/*$::')
EP_KEY=$(grep -E '^EASYPANEL_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ')
: "${EP_URL:?falta EASYPANEL_URL en $ENV_FILE}"
: "${EP_KEY:?falta EASYPANEL_API_KEY en $ENV_FILE}"

servicios() {
  curl -fsS -X POST -H "Authorization: Bearer $EP_KEY" -H 'Content-Type: application/json' -d '{}' \
    "$EP_URL/api/trpc/projects.listProjectsAndServices"
}
TOKEN=$(servicios | python3 -c "import sys,json
r=json.load(sys.stdin)
d=r.get('result',{}).get('data',{}).get('json') or r.get('json') or r
print(next(s['token'] for s in d['services']
          if s['projectName']=='$PROJECT' and s['name']=='$SERVICE'))") || {
  echo "No pude obtener el deploy token de $PROJECT/$SERVICE" >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "Deploy token vacío para $PROJECT/$SERVICE" >&2; exit 1; }

echo "Disparando deploy de $PROJECT/$SERVICE en EasyPanel..."
HTTP=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "$EP_URL/api/deploy/$TOKEN" \
  -H 'Content-Type: application/json' -d '{}') || { echo "El disparo falló" >&2; exit 1; }
echo "Deploy disparado (HTTP $HTTP). Esperando a que el contenedor corra ${LOCAL:0:7}…"

# ── 2. ¿El contenedor corre ESTE código? ─────────────────────────────────────────────────────
# La huella del código versionado, comparada contra los archivos dentro del contenedor. Mide lo
# que de verdad está corriendo, no lo que EasyPanel cree haber construido.
LISTA=$(cd "$REPO/app" && git ls-files '*.js' '*.html' '*.css' | grep -v '^node_modules/' | sort)
HUELLA_LOCAL=$(cd "$REPO/app" && printf '%s\n' "$LISTA" | xargs md5sum | md5sum | cut -d' ' -f1)
huella_contenedor() {
  local c
  c=$(docker ps --format '{{.Names}}' | grep "^${PROJECT}_${SERVICE}\." | head -1) || return 1
  [ -n "$c" ] || return 1
  printf '%s\n' "$LISTA" | docker exec -i "$c" sh -c 'cd /app && xargs md5sum 2>/dev/null | md5sum' \
    2>/dev/null | cut -d' ' -f1
}

for i in $(seq 1 $ESPERA_MAX); do
  sleep 10
  if [ "$(huella_contenedor)" = "$HUELLA_LOCAL" ]; then
    echo "OK: el contenedor corre tu código (${LOCAL:0:7})."
    exit 0
  fi
done
echo "Pasaron $((ESPERA_MAX*10))s y el contenedor todavía no corre ${LOCAL:0:7}." >&2
echo "Mirá el build en $EP_URL (proyecto $PROJECT, servicio $SERVICE)." >&2
exit 1
