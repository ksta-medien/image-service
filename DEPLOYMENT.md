# Deployment Anleitung

## Problem gelöst

Der Fehler "Input buffer contains unsupported image format" wurde durch **fehlende Authentifizierung** beim Zugriff auf den GCS-Bucket verursacht. Der Service versuchte, eine HTML-Login-Seite als Bild zu verarbeiten.

## Lösung

Der Image-Service verwendet jetzt die Google Cloud Storage API mit automatischer Authentifizierung über den Service Account.

## Deployment

### 1. Dependencies installieren

```bash
cd image-service
npm install
```

### 2. Docker Image bauen

```bash
docker build -t europe-west3-docker.pkg.dev/dmx-case42/image-service/image-service:latest .
```

### 3. Image pushen

```bash
docker push europe-west3-docker.pkg.dev/dmx-case42/image-service/image-service:latest
```

### 4. Nach Cloud Run deployen

```bash
gcloud run deploy image-service \
  --image europe-west3-docker.pkg.dev/dmx-case42/image-service/image-service:latest \
  --region europe-west3 \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 10 \
  --min-instances 0 \
  --timeout 60s \
  --port 8080 \
  --set-env-vars="GCS_BUCKET_NAME=livingdocs-image-live,GCS_BUCKET_BASE_URL=https://storage.cloud.google.com/livingdocs-image-live"
```

## Wichtig: Service Account Berechtigungen

Der Cloud Run Service Account muss Lesezugriff auf den GCS-Bucket haben:

```bash
# Service Account Email finden
gcloud run services describe image-service --region europe-west3 --format='value(spec.template.spec.serviceAccountName)'

# Berechtigung erteilen
gsutil iam ch serviceAccount:SERVICE_ACCOUNT_EMAIL:objectViewer gs://livingdocs-image-live
```

Oder in der Google Cloud Console:
1. Gehe zu Cloud Storage > livingdocs-image-live
2. Klicke auf "Permissions"
3. Füge den Service Account mit der Rolle "Storage Object Viewer" hinzu

## Änderungen

### 1. package.json
- Hinzugefügt: `@google-cloud/storage` für authentifizierte GCS-Zugriffe

### 2. Dockerfile
- Gewechselt von Alpine zu Debian für bessere Sharp-Unterstützung
- Verwendet npm statt bun für Sharp-Installation (bessere native Module Unterstützung)

### 3. src/app.ts
- Neue Funktion `fetchImageFromGCS()` für authentifizierte Downloads
- Verwendet Google Cloud Storage SDK statt direkter HTTP-Anfragen
- Besseres Error-Handling und Logging

### 4. src/image-processor.ts
- Verbesserte Sharp-Initialisierung
- Detailliertes Metadaten-Logging für Debugging
- Besseres Error-Handling

## Test

Nach dem Deployment sollte diese URL funktionieren:

```bash
curl "https://image-service-734680744363.europe-west3.run.app/2026/03/25/bf2407b1-1998-4fdb-9243-c92d05069698.jpeg?q=75&rect=0,46,4000,2250&w=1000&h=563&fm=avif"
```

## Logs überprüfen

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=image-service' --limit 50 --project dmx-case42
```
