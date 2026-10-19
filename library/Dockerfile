# The Go helper is cross-compiled on the build machine, so its tests run
# natively even when building the arm64 image.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS recording
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY recording/ ./
RUN go test ./... && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -o /recording-server .

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py start.py entrypoint.sh ./
COPY recording recording
COPY --from=recording /recording-server /usr/local/bin/recording-server
ENV RECORDING_SERVER=http://127.0.0.1:8001
COPY templates templates
COPY static static
COPY LICENSE NOTICE.md VIEWER.md Dockerfile ./
# Some hosts (Unraid's boot flash) expose build-context files as root-only.
RUN chmod -R a+rX /app && chmod a+x /app/entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
# One process makes the copy lock global; threads allow browsing during copies.
CMD ["python", "start.py"]
