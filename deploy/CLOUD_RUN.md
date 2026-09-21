# Running Launchpad Network on Google Cloud Run

A tested recipe for a small demo or pilot instance. Replace the `<…>` placeholders with your own
project, bucket and PortableMind workspace.

## Why it needs more than a plain `gcloud run deploy`

This app keeps **state on disk**: the encrypted per-workspace secret store (`secrets.enc`) and the
accelerator registry (`state.json`). Cloud Run's filesystem is wiped on every restart, so `DATA_DIR`
must be a **Cloud Storage volume**, which needs the `gen2` execution environment. Sessions live in
memory, so run **one instance** (`--max-instances 1`). With scale-to-zero, people are signed out after
an idle spell.

## One-time setup

```bash
P=<gcp-project-id>; R=us-central1; B=${P}-launchpad-network-data
gcloud storage buckets create gs://$B --project $P --location $R --uniform-bucket-level-access
# the runtime service account must be able to read/write the bucket
gcloud storage buckets add-iam-policy-binding gs://$B \
  --member serviceAccount:<project-number>-compute@developer.gserviceaccount.com \
  --role roles/storage.objectAdmin
openssl rand -hex 32   # your SECRET_STORE_KEY; keep it safe and never change it
```

## Deploy / redeploy

```bash
gcloud run deploy launchpad-network --source . --project $P --region $R \
  --allow-unauthenticated --port 8080 --memory 512Mi --cpu 1 \
  --min-instances 0 --max-instances 1 --timeout 3600 --execution-environment gen2 \
  --add-volume "name=data,type=cloud-storage,bucket=$B,mount-options=uid=1000;gid=1000" \
  --add-volume-mount "volume=data,mount-path=/data" \
  --set-env-vars "^|^PM_API=https://www.dsiloed.com|PM_APP_URL=https://app.portablemind.ai|NETWORK_WORKSPACE=<your-enterprise-workspace>|NETWORK_NAME=Launchpad Network|DATA_DIR=/data|PUBLIC_URL=https://<service-url>|TRUST_PROXY=1"
# then add SECRET_STORE_KEY, preferably from Secret Manager:
#   --set-secrets SECRET_STORE_KEY=<secret-name>:latest
```

`PUBLIC_URL` is only known after the first deploy. Deploy, then set it with
`gcloud run services update launchpad-network --update-env-vars PUBLIC_URL=https://…`, and add its host
to each accelerator's `return_url_allowlist`.

A code-only redeploy needs just `gcloud run deploy launchpad-network --source . --project $P --region $R`.
Env vars and the volume carry over. Use `--update-env-vars` to change one value, because
`--set-env-vars` replaces the whole environment.

`SECRET_STORE_KEY` must be the key that encrypted `secrets.enc` in the bucket. Otherwise every stored
provisioning key, sign-on key and invite code is unreadable.

`FOUNDER_EMAIL_VERIFICATION=off` is for **staging demos only** (e.g. `.test` addresses that can't
receive mail). Never run it that way against production.

## Health

`GET /health` → `{"ok":true}`. (`/healthz` is intercepted by Cloud Run's front end.)

## Tear down

```bash
gcloud run services delete launchpad-network --project $P --region $R --quiet
gcloud storage rm -r gs://$B          # only if you are done with the data too
```
