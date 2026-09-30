# Image TranspoZ : serveur web + moteur(s) de reconnaissance de partitions.
#
#   docker build -t transpoz .
#   docker run -p 8000:8000 transpoz
#
# Moteurs OMR :
#   - oemer (installé par défaut, WITH_OEMER=1) ; ses modèles sont téléchargés
#     depuis GitHub au premier usage.
#   - Audiveris (recommandé pour les PDF imprimés) : passer l'URL du paquet .deb
#     d'une release, ex.
#     --build-arg AUDIVERIS_DEB_URL=https://github.com/Audiveris/audiveris/releases/download/<version>/<fichier>.deb

FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM python:3.11-slim
ARG WITH_OEMER=1
ARG AUDIVERIS_DEB_URL=""
ENV PYTHONUNBUFFERED=1 OMR_ENGINE=auto

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libgl1 libglib2.0-0 \
 && if [ -n "$AUDIVERIS_DEB_URL" ]; then \
      curl -fsSL "$AUDIVERIS_DEB_URL" -o /tmp/audiveris.deb \
      && apt-get install -y --no-install-recommends /tmp/audiveris.deb \
      && rm /tmp/audiveris.deb; \
    fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$WITH_OEMER" = "1" ]; then pip install --no-cache-dir oemer; fi

COPY --from=web /app/node_modules ./node_modules
COPY server ./server
COPY web ./web

ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT}"]
