FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ffmpeg ca-certificates \
  && python3 -m venv /opt/py \
  && /opt/py/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/py/bin/pip install --no-cache-dir gallery-dl yt-dlp \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/py/bin:${PATH}"

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Inject custom gallery-dl extractor module (fapopello)
RUN python3 - <<'PY'
import os, shutil, glob
mods = glob.glob('/opt/py/lib/python*/site-packages/gallery_dl/extractor')
if mods:
    target = mods[0]
    os.makedirs(target, exist_ok=True)
    shutil.copy('/app/extractors/fapopello.py', os.path.join(target, 'fapopello.py'))
    print('installed custom extractor:', os.path.join(target, 'fapopello.py'))
else:
    print('gallery_dl extractor path not found')
PY

CMD ["npm", "start"]
