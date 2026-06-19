#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
APP_DIR="${APP_DIR:-/var/app/current}"
GET_CONFIG="/opt/elasticbeanstalk/bin/get-config"

usage() {
  cat <<'EOF'
Usage:
  run_eb_subscription_maintenance.sh cleanup-dry
  run_eb_subscription_maintenance.sh cleanup-write
  run_eb_subscription_maintenance.sh reconcile-dry
  run_eb_subscription_maintenance.sh reconcile-write

The script loads MONGO_URI/MONGODB_URI and STRIPE_SECRET_KEY from the
Elastic Beanstalk environment without printing their values.
EOF
}

load_eb_value() {
  local key="$1"
  local value=""

  if [[ -x "$GET_CONFIG" ]]; then
    value="$("$GET_CONFIG" environment -k "$key" 2>/dev/null || true)"
  fi

  printf '%s' "$value"
}

if [[ -z "${MONGO_URI:-}" && -z "${MONGODB_URI:-}" ]]; then
  MONGO_URI="$(load_eb_value MONGO_URI)"
  if [[ -z "$MONGO_URI" ]]; then
    MONGODB_URI="$(load_eb_value MONGODB_URI)"
    export MONGODB_URI
  else
    export MONGO_URI
  fi
fi

if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  STRIPE_SECRET_KEY="$(load_eb_value STRIPE_SECRET_KEY)"
  export STRIPE_SECRET_KEY
fi

if [[ -z "${MONGO_URI:-}" && -z "${MONGODB_URI:-}" ]]; then
  echo "ERROR: MONGO_URI/MONGODB_URI is unavailable in the EB environment." >&2
  exit 2
fi

if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  echo "ERROR: STRIPE_SECRET_KEY is unavailable in the EB environment." >&2
  exit 2
fi

cd "$APP_DIR"

case "$ACTION" in
  cleanup-dry)
    exec npm run subscriptions:cleanup:dry
    ;;
  cleanup-write)
    exec npm run subscriptions:cleanup
    ;;
  reconcile-dry)
    exec npm run subscriptions:reconcile:dry
    ;;
  reconcile-write)
    exec npm run subscriptions:reconcile
    ;;
  *)
    usage
    exit 64
    ;;
esac
