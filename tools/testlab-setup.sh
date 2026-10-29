#!/bin/bash
# Sets up a Google Cloud project once, so that android.yml's real-devices job can run the
# app's tests on real phones in Firebase Test Lab. Run it in Cloud Shell (the >_ button
# in the Google Cloud console), with the project chosen at the top of the console:
#
#   bash tools/testlab-setup.sh                  # for soroushaz1/roja
#   ROJA_REPO=owner/repo bash tools/testlab-setup.sh
#
# Add Firebase to the project first (console.firebase.google.com → Add project → pick
# this Google Cloud project): Test Lab is part of Firebase.
#
# What it makes, each only if it is not there yet, so it can be run again safely:
#   - the APIs Test Lab and the keyless sign-in need;
#   - roja-testlab, a service account the tests run as (Editor on this project only,
#     the role Test Lab's documentation asks for: keep the project for this alone);
#   - a workload identity pool "github" with a provider "roja" that trusts GitHub's
#     sign-in tokens only from this repository's main branch, and lets those act as the
#     service account. No key is made, so there is none to leak or rotate;
#   - a bucket for the phones' results, which forgets each run after 30 days.
# and at the end prints the repository variables to set on GitHub.
set -euo pipefail

REPO=${ROJA_REPO:-soroushaz1/roja}
PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null)}
[ -n "$PROJECT" ] || { echo "Choose a project first: gcloud config set project <id>"; exit 1; }
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA=roja-testlab@$PROJECT.iam.gserviceaccount.com
POOL=github
PROVIDER=roja
BUCKET=roja-testlab-$PROJECT
echo "Project $PROJECT ($NUMBER), for $REPO"

# Test Lab needs the project to be a Firebase project as well.
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firebase.googleapis.com/v1beta1/projects/$PROJECT")
if [ "$status" != 200 ]; then
  echo "This project is not a Firebase project yet (HTTP $status)."
  echo "Add Firebase to it at https://console.firebase.google.com/ (Add project → this project), then run this again."
  exit 1
fi

echo "== APIs"
gcloud services enable testing.googleapis.com toolresults.googleapis.com storage.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT"

echo "== Service account $SA"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create roja-testlab --project "$PROJECT" \
    --display-name 'Roja: Test Lab runs from GitHub Actions'
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" \
  --role roles/editor --condition None >/dev/null

echo "== Workload identity: GitHub's main branch of $REPO, and nothing else"
gcloud iam workload-identity-pools describe "$POOL" --location global --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location global --project "$PROJECT" \
    --display-name 'GitHub Actions'
condition="assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool "$POOL" \
     --location global --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" --workload-identity-pool "$POOL" \
    --location global --project "$PROJECT" --attribute-condition "$condition" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --workload-identity-pool "$POOL" \
    --location global --project "$PROJECT" --display-name "$REPO" \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
    --attribute-condition "$condition"
fi
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" \
  >/dev/null

echo "== Results bucket gs://$BUCKET"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location us-central1 \
    --uniform-bucket-level-access
printf '%s' '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' > /tmp/roja-lifecycle.json
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file /tmp/roja-lifecycle.json >/dev/null
rm -f /tmp/roja-lifecycle.json

cat <<EOF

Done. On GitHub, in $REPO: Settings → Secrets and variables → Actions → Variables,
add these four repository variables (variables, not secrets: none of them is a secret):

  ROJA_GCP_PROJECT           $PROJECT
  ROJA_GCP_PROVIDER          projects/$NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER
  ROJA_GCP_SERVICE_ACCOUNT   $SA
  ROJA_TESTLAB_BUCKET        $BUCKET

The next push to main (or "Run workflow" on the Android app workflow) runs the tests on
real phones as well. The phones the job would choose today:
EOF
gcloud firebase test android models list --format=json --project "$PROJECT" 2>/dev/null |
  sh "$(dirname "$0")/../.github/testlab-devices.sh" 2>/dev/null | sed 's/^/  /' ||
  echo "  (run from the repository's folder to see them)"
