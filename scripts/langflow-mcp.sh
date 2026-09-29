#!/bin/zsh

set -eu

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
env_file="$project_dir/.env.local"

if [[ ! -f "$env_file" ]]; then
  print -u2 "Missing $env_file"
  exit 1
fi

set -a
source "$env_file"
set +a

if [[ -z "${LANGFLOW_API_KEY:-}" || "$LANGFLOW_API_KEY" == "replace_with_your_langflow_api_key" ]]; then
  print -u2 "LANGFLOW_API_KEY is not configured in $env_file"
  exit 1
fi

uvx_path="$(command -v uvx || true)"
if [[ -z "$uvx_path" && -x "/Users/sanchittomar/.local/bin/uvx" ]]; then
  uvx_path="/Users/sanchittomar/.local/bin/uvx"
fi

if [[ -z "$uvx_path" ]]; then
  print -u2 "uvx is required to start the Langflow MCP client"
  exit 1
fi

exec "$uvx_path" --from lfx lfx-mcp

