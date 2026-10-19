# Dockerfile raíz para EasyPanel: construye ClauLogic desde la raíz del repo.
# Igual que en ClaUsina, el Dockerfile vive en la RAÍZ y no dentro de app/: EasyPanel construye
# desde la raíz del repo, y tener uno adentro confunde a quien lo busca.
FROM node:22-alpine
WORKDIR /app
# El package.json primero y solo: así la capa de npm install se reaprovecha mientras no cambien
# las dependencias, y un cambio de código no reinstala todo.
COPY app/package.json ./
RUN npm install --omit=dev
COPY app/ ./
EXPOSE 3002
CMD ["node", "server.js"]
