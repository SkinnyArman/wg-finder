FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 TZ=Europe/Berlin

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY wgfinder/ ./wgfinder/
# profile.yaml is personal and not in the repo — mount it at runtime:
#   docker run -v $PWD/profile.yaml:/app/profile.yaml ...

# wgfinder.db lives here so it survives container restarts
VOLUME /app/data
ENV WGFINDER_DB=/app/data/wgfinder.db

CMD ["python", "-m", "wgfinder.bot"]
