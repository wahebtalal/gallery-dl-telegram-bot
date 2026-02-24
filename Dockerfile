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

CMD ["npm", "start"]
