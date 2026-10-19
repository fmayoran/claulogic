# ClauLogic

Aplicación independiente sobre la infraestructura del VPS (EasyPanel + Traefik).
Node 22 + Express + PostgreSQL 17.

```
app/              servidor Express, cliente de la base, cifrado y estáticos
scripts/db/       migraciones SQL numeradas
scripts/migrar.sh corredor de migraciones (idempotente, con registro)
deploy.sh         despliegue verificado contra EasyPanel
Dockerfile        imagen que construye EasyPanel desde la raíz del repo
```

Puesta en marcha y convenciones: ver `CLAUDE.md`.
