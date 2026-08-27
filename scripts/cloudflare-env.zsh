#!/bin/zsh

export CLOUDFLARE_ACCOUNT_ID="96cf3886ebd2c63d32d8455b9667b46c"

# Wrangler OAuth is preferred because the original API token has narrower
# permissions. Opt in only for commands that intentionally use that token.
if [[ "$HOMEOS_USE_KEYCHAIN_API_TOKEN" == "1" ]]; then
  task_cloudflare_token="$(security find-generic-password -s cloudflare-api-token -a dhrvrm-home-os -w 2>/dev/null)"
  if [[ -z "$task_cloudflare_token" ]]; then
    print -u2 "Cloudflare token not found in macOS Keychain (service cloudflare-api-token, account dhrvrm-home-os)."
    return 1
  fi
  export CLOUDFLARE_API_TOKEN="$task_cloudflare_token"
  unset task_cloudflare_token
fi
