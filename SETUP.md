# GitHub Actions Setup Guide

This guide walks you through configuring the GitHub Actions secrets needed for automatic deployment to Google Cloud Run using Workload Identity Federation (recommended and most secure method).

## Prerequisites

- A Google Cloud project with billing enabled
- `gcloud` CLI installed and authenticated
- Owner or Editor role on the GCP project

## Setup Workload Identity Federation

Workload Identity Federation allows GitHub Actions to authenticate to Google Cloud without using service account keys, which is more secure.

### Step 1: Set Environment Variables

```bash
# Replace with your actual values
export PROJECT_ID="your-gcp-project-id"
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export REPO="ksta-medien/image-service"
export SERVICE_ACCOUNT_NAME="github-actions-deployer"
```

### Step 2: Enable Required APIs

```bash
gcloud services enable iamcredentials.googleapis.com \
  --project="${PROJECT_ID}"

gcloud services enable run.googleapis.com \
  --project="${PROJECT_ID}"

gcloud services enable containerregistry.googleapis.com \
  --project="${PROJECT_ID}"
```

### Step 3: Create Service Account

```bash
gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
  --project="${PROJECT_ID}" \
  --display-name="GitHub Actions Deployer"
```

### Step 4: Grant Permissions to Service Account

```bash
# Cloud Run Admin (to deploy services)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.admin"

# Storage Admin (to push container images)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

# Service Account User (required for Cloud Run)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

### Step 5: Create Workload Identity Pool

```bash
gcloud iam workload-identity-pools create "github-pool" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions Pool"
```

### Step 6: Create Workload Identity Provider

```bash
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner=='ksta-medien'" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

### Step 7: Allow GitHub Actions to Impersonate Service Account

```bash
gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${REPO}"
```

### Step 8: Get Workload Identity Provider Resource Name

```bash
gcloud iam workload-identity-pools providers describe "github-provider" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --format="value(name)"
```

This will output something like:
```
projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider
```

**Copy this value** - you'll need it for the GitHub secret.

## Configure GitHub Secrets

Go to https://github.com/ksta-medien/image-service/settings/secrets/actions and add the following secrets:

### 1. GCP_PROJECT_ID
- **Value**: Your GCP project ID (e.g., `my-project-123456`)

### 2. WIF_PROVIDER
- **Value**: The full workload identity provider resource name from Step 8
- **Example**: `projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider`

### 3. WIF_SERVICE_ACCOUNT
- **Value**: The service account email
- **Format**: `github-actions-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com`
- **Example**: `github-actions-deployer@my-project-123456.iam.gserviceaccount.com`

## Verify Setup

Once all secrets are configured:

1. Push a commit to the `main` branch:
   ```bash
   git commit --allow-empty -m "Test deployment"
   git push
   ```

2. Go to the Actions tab: https://github.com/ksta-medien/image-service/actions

3. Watch the workflow run and deploy to Cloud Run

## Troubleshooting

### "workload_identity_provider" error
- Ensure `WIF_PROVIDER` secret is set with the full resource name
- Verify it starts with `projects/` and includes the full path

### Permission errors
- Verify the service account has all three required roles
- Check that the workload identity binding is correct
- Ensure the repository name in Step 7 matches exactly: `ksta-medien/image-service`

### Authentication failures
- Verify the attribute condition in Step 6 matches your organization: `ksta-medien`
- Check that `id-token: write` permission is set in the workflow (it is)

### API not enabled errors
- Run the Step 2 commands to enable all required APIs
- Wait a few minutes for APIs to fully enable

## Benefits of Workload Identity Federation

✅ **No service account keys** - More secure, no keys to rotate or leak  
✅ **Automatic token management** - GitHub handles token lifecycle  
✅ **Fine-grained access control** - Can restrict to specific repositories  
✅ **Audit trail** - Better tracking of who deployed what  

## Manual Deployment (Alternative)

If you prefer to deploy manually instead of using GitHub Actions:

```bash
# Authenticate
gcloud auth login

# Set project
gcloud config set project $PROJECT_ID

# Build and push
gcloud builds submit --tag gcr.io/$PROJECT_ID/imgx-clone

# Deploy
gcloud run deploy imgx-clone \
  --image gcr.io/$PROJECT_ID/imgx-clone \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars="GCS_BUCKET_BASE_URL=https://storage.cloud.google.com/livingdocs-image-live"
```

## Security Notes

- The workload identity setup restricts access to repositories owned by `ksta-medien`
- Only workflows running on the `main` branch will trigger deployments
- The service account has minimal required permissions (Cloud Run, Storage, IAM)
- No long-lived credentials are stored in GitHub

## Reference Documentation

- [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
- [GitHub Actions OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [google-github-actions/auth](https://github.com/google-github-actions/auth)
