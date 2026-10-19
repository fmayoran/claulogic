#!/usr/bin/env bash
# Aplica las migraciones pendientes de scripts/db/, en orden, UNA sola vez cada una.
#
# ClaUsina aplica su SQL a mano y confía en que alguien se acuerde de cuál corrió. Acá queda
# asentado en logic.migracion con el sha256 del archivo, así que:
#   - una migración ya aplicada no se vuelve a correr;
#   - si alguien EDITA una migración ya aplicada, se detecta y se frena, en vez de dejar la base
#     y el repo contando historias distintas.
#
# Uso: scripts/migrar.sh [--ver]     (--ver = decir qué haría, sin tocar nada)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./claulogic.env; set +a

VER=0; [ "${1:-}" = "--ver" ] && VER=1
CID=$(docker ps -q -f name=claulogic_db.1.)
[ -n "$CID" ] || { echo "no encuentro el contenedor de la base (claulogic_db)" >&2; exit 1; }
psql(){ docker exec -i "$CID" psql -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 "$@"; }
q(){ psql -t -A -c "$1"; }

pendientes=0
for f in $(ls scripts/db/migration_*.sql 2>/dev/null | sort); do
  nombre=$(basename "$f")
  sha=$(sha256sum "$f" | cut -d' ' -f1)
  guardado=$(q "SELECT sha256 FROM logic.migracion WHERE archivo='$nombre';")
  if [ -n "$guardado" ]; then
    if [ "$guardado" != "$sha" ]; then
      echo "ERROR: $nombre ya se aplicó pero el archivo cambió desde entonces." >&2
      echo "       La base tiene una versión y el repo otra. Escribí una migración nueva" >&2
      echo "       en vez de editar una aplicada." >&2
      exit 2
    fi
    continue
  fi
  pendientes=$((pendientes+1))
  if [ "$VER" = "1" ]; then echo "pendiente: $nombre"; continue; fi
  echo "aplicando $nombre"
  # La migración y su registro van en la MISMA transacción: si el SQL falla a la mitad, no queda
  # anotada como aplicada. Anotarla aparte es como se llega a una base que miente.
  { echo "BEGIN;"; cat "$f";
    echo "INSERT INTO logic.migracion (archivo, sha256) VALUES ('$nombre','$sha');";
    echo "COMMIT;"; } | psql -q
done

[ "$pendientes" = "0" ] && echo "sin migraciones pendientes" || \
  { [ "$VER" = "1" ] && echo "$pendientes pendiente(s)" || echo "listo: $pendientes aplicada(s)"; }
