#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo 'public repository audit requires a Git worktree' >&2
  exit 2
fi

findings=()
scanner=${FLAMA_AUDIT_SCANNER:-auto}

if [[ "$scanner" == "auto" ]]; then
  if command -v rg >/dev/null 2>&1; then
    scanner=rg
  elif command -v grep >/dev/null 2>&1; then
    scanner=grep
  else
    echo 'public repository audit requires ripgrep or grep' >&2
    exit 3
  fi
elif [[ "$scanner" != "rg" && "$scanner" != "grep" ]]; then
  echo 'public repository audit scanner selection is invalid' >&2
  exit 2
elif ! command -v "$scanner" >/dev/null 2>&1; then
  echo 'public repository audit scanner is unavailable' >&2
  exit 3
fi

contains_pattern() {
  local pattern=$1
  local path=$2
  local status
  if [[ "$scanner" == "rg" ]]; then
    if rg -q --pcre2 -- "$pattern" "$path"; then status=0; else status=$?; fi
  else
    if grep -Pq -- "$pattern" "$path"; then status=0; else status=$?; fi
  fi
  if [[ $status -eq 0 ]]; then
    return 0
  fi
  if [[ $status -ne 1 ]]; then
    echo 'public repository audit scanner failed' >&2
    exit 3
  fi
  return 1
}

is_text_file() {
  local path=$1
  local status
  if [[ "$scanner" == "rg" ]]; then
    if rg -Iq . "$path"; then status=0; else status=$?; fi
  else
    if grep -Iq . -- "$path"; then status=0; else status=$?; fi
  fi
  if [[ $status -eq 0 ]]; then
    return 0
  fi
  if [[ $status -ne 1 ]]; then
    echo 'public repository audit scanner failed' >&2
    exit 3
  fi
  return 1
}

while IFS= read -r -d '' relative_path; do
  case "/$relative_path" in
    */.env|*/.env.*|*/.npmrc|*/.pypirc|*/credentials.json|*/config.json.docker-auth|*/id_rsa|*/id_ed25519|*/kubeconfig|*.pem|*.key|*.p12|*.pfx|*.keystore|*.tfstate|*.tfvars|*.private-inventory.json|*/phase0-github-*.json)
      case "/$relative_path" in
        */.env.example|*/.env.sample|*/.npmrc.example|*/.pypirc.example) ;;
        *) findings+=("forbidden_sensitive_path") ;;
      esac
      ;;
  esac

  [[ "$relative_path" == "scripts/public-repository-audit.sh" ]] && continue
  path="$ROOT_DIR/$relative_path"
  [[ -f "$path" ]] || continue
  [[ $(wc -c <"$path") -le 10485760 ]] || continue
  is_text_file "$path" || continue

  if contains_pattern '(-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|pypi-AgEI[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Fa-f0-9]{32,}|st\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})' "$path"; then
    findings+=("credential_signature")
  fi

  if contains_pattern '(?i)(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|webhook[_-]?secret)\s*[:=]\s*"(?!(?:test-only|example|placeholder|redacted|dummy|missing-))[^"\r\n]{12,}"' "$path" ||
    contains_pattern "(?i)(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|webhook[_-]?secret)\\s*[:=]\\s*'(?!(?:test-only|example|placeholder|redacted|dummy|missing-))[^'\\r\\n]{12,}'" "$path"; then
    findings+=("literal_secret_assignment")
  fi

  if contains_pattern '(?im)^\s*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|webhook[_-]?secret)\s*[:=]\s*(?!(?:\$\{|process\.env|env\.|test-only|example|placeholder|redacted|dummy|missing-|<))[A-Za-z0-9+/_=-]{16,}\s*$' "$path" ||
    contains_pattern '(?i)\b(?:https?|postgres(?:ql)?|mysql)://[^/@:\s]+:[^/@\s]{8,}@' "$path"; then
    findings+=("unquoted_or_url_secret")
  fi

  if [[ "$relative_path" != tests/fixtures/* && "$relative_path" != packages/contracts/test/fixtures/* ]] &&
    contains_pattern '"(?:isPrivate|visibility)"\s*:\s*(?:true|"private")' "$path" &&
    contains_pattern '"(?:nameWithOwner|fullName|repositories)"\s*:' "$path"; then
    findings+=("private_repository_inventory")
  fi

  if [[ "$relative_path" != tests/fixtures/* && "$relative_path" != packages/contracts/test/fixtures/* ]] &&
    contains_pattern '(?i)(?:paperclip[^\r\n]{0,80})?\b[0-9]+\s+(?:active\s+)?(?:agents?|projects?|routines?|workspaces?)\s+(?:exist|observed|found|configured|installed)|\b(?:agent|project|routine|workspace)Count\b\s*[:=]' "$path"; then
    findings+=("paperclip_inventory_measurement")
  fi
done < <(git -C "$ROOT_DIR" ls-files --cached --others --exclude-standard -z)

if (( ${#findings[@]} > 0 )); then
  printf 'public repository audit failed: %d sanitized finding(s)\n' "${#findings[@]}" >&2
  printf '%s\n' "${findings[@]}" | sort | uniq -c | sed -E 's/^[[:space:]]+//' >&2
  exit 1
fi

echo 'public repository audit passed: no credential signatures, sensitive paths, or private inventory detected'
