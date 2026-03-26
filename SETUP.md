# GitHub Actions Setup Guide

This guide walks you through configuring the GitHub Actions secrets needed for automatic deployment to Google Cloud Run.

## Required GitHub Secrets

You need to configure two secrets in your GitHub repository:

### 1. GCP_PROJECT_ID

Your Google Cloud project ID.

**Steps:**
1. Go to https://github.com/ksta-medien/image-service/settings/secrets/actions
2. Click "New repository secret"
3. Name: `GCP_PROJECT_ID`
4. Value: Your GCP project ID (e.g., `my-project-123456`)
5. Click "Add secret"

### 2. GCP_SA_KEY

A service account key JSON with permissions to deploy to Cloud Run and push to Container Registry.

**Steps to create the service account:**

1. **Create a service account:**
   ```bash
   gcloud iam service-accounts create github-actions-deployer \
     --display-name="GitHub Actions Deployer"
   ```

2. **Grant necessary permissions:**
   ```bash
   # Replace YOUR_PROJECT_ID with your actual project ID
   PROJECT_ID="YOUR_PROJECT_ID"
   
   # Cloud Run Admin (to deploy services)
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
     --role="roles/run.admin"
   
   # Storage Admin (to push container images)
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
     --role="roles/storage.admin"
   
   # Service Account User (required for Cloud Run)
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountUser"
   ```

3. **Create and download the key:**
   ```bash
   gcloud iam service-accounts keys create github-actions-key.json \
     --iam-account=github-actions-deployer@${PROJECT_ID}.iam.gserviceaccount.com
   ```

4. **Add to GitHub Secrets:**
   - Open the downloaded `github-actions-key.json` file
   - Copy the entire JSON content
   - Go to https://github.com/ksta-medien/image-service/settings/secrets/actions
   - Click "New repository secret"
   - Name: `GCP_SA_KEY`
   - Value: Paste the entire JSON content
   - Click "Add secret"

5. **Delete the local key file (important for security):**
   ```bash
   rm github-actions-key.json
   ```

## Verify Setup

Once both secrets are configured:

1. Push a commit to the `main` branch
2. Go to the Actions tab: https://github.com/ksta-medien/image-service/actions
3. Watch the workflow run and deploy to Cloud Run

## Troubleshooting

### "credentials_json" error
- Ensure `GCP_SA_KEY` secret is set with valid JSON
- Check that the JSON is complete and not truncated

### Permission errors
- Verify the service account has all three required roles
- Make sure you're using the correct project ID

### Image push failures
- Enable the Container Registry API: https://console.cloud.google.com/apis/library/containerregistry.googleapis.com
- Enable the Cloud Run API: https://console.cloud.google.com/apis/library/run.googleapis.com

## Manual Deployment (Alternative)

If you prefer to deploy manually instead of using GitHub Actions:

```bash
# Authenticate
gcloud auth login

# Set project
gcloud config set project YOUR_PROJECT_ID

# Build and push
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/imgx-clone

# Deploy
gcloud run deploy imgx-clone \
  --image gcr.io/YOUR_PROJECT_ID/imgx-clone \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars="GCS_BUCKET_BASE_URL=https://storage.cloud.google.com/livingdocs-image-live"
```
