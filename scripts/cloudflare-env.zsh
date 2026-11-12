#!/bin/zsh

export CLOUDFLARE_ACCOUNT_ID="96cf3886ebd2c63d32d8455b9667b46c"

# Deployment credentials stay in the OS keychain. Set the switch to 0 to use
# an existing Wrangler OAuth session instead. Never enable shell tracing here.
if [[ "${HOMEOS_USE_KEYCHAIN_API_TOKEN:-1}" == "1" ]]; then
  task_cloudflare_token="$(security find-generic-password -s home-os-deployment-token -a home-os -w 2>/dev/null)"
  if [[ -z "$task_cloudflare_token" ]]; then
    print -u2 "Deployment token not found in macOS Keychain (service home-os-deployment-token, account home-os). Use Wrangler OAuth with HOMEOS_USE_KEYCHAIN_API_TOKEN=0."
    return 1
  fi
  export CLOUDFLARE_API_TOKEN="$task_cloudflare_token"
  unset task_cloudflare_token
fi
