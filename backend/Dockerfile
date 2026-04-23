FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libsndfile1 \
    libfluidsynth3 \
    curl \
    && curl -fL "https://github.com/Audiveris/audiveris/releases/download/5.10.2/Audiveris-5.10.2-ubuntu22.04-x86_64.deb" \
       -o /tmp/audiveris.deb \
    && apt-get install -y --no-install-recommends libxtst6 \
    && dpkg-deb -x /tmp/audiveris.deb / \
    && rm /tmp/audiveris.deb \
    && rm -rf /var/lib/apt/lists/*

ENV AUDIVERIS_HOME=/opt/audiveris

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir "git+https://github.com/pymatchmaker/matchmaker.git@533dea2"

RUN mkdir -p uploads

COPY app/ ./app/

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
