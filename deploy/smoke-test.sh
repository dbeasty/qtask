#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3003}"
TEST_EMAIL="${TEST_EMAIL:-}"

pass() { echo "  OK: $*"; }
fail() { echo "  FAIL: $*" >&2; exit 1; }
skip() { echo "  SKIP: $*"; }

echo "QTask smoke test — ${BASE_URL}"
echo ""

echo "1. Health"
health="$(curl -fsS "${BASE_URL}/health")"
echo "   ${health}"
echo "${health}" | grep -q '"mongodb":"ok"' || fail "MongoDB check failed"
pass "health"

echo ""
echo "2. Web UI (static client)"
status="$(curl -sS -o /tmp/qtask-smoke-index.html -w "%{http_code}" "${BASE_URL}/")"
[[ "${status}" == "200" ]] || fail "GET / returned ${status} (expected 200 HTML)"
head -c 80 /tmp/qtask-smoke-index.html | grep -qi '<!doctype html\|<html' || fail "GET / did not return HTML"
pass "web UI"

echo ""
echo "3. Auth config"
auth_config="$(curl -fsS "${BASE_URL}/api/auth/config")"
echo "   ${auth_config}"
registration_enabled="$(echo "${auth_config}" | grep -o '"registrationEnabled":[^,}]*' | cut -d: -f2 | tr -d ' ')"

echo ""
echo "4. Auth API (register)"
if [[ "${registration_enabled}" == "false" ]]; then
  skip "registration disabled (SMTP not configured or misconfigured)"
  skip "login-before-verify check (no test account created)"
else
  if [[ -z "${TEST_EMAIL}" ]]; then
    TEST_EMAIL="qtask-smoke-$(date +%s)@example.com"
  fi
  register_body="$(curl -fsS -X POST "${BASE_URL}/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"smoke-test-pass\",\"acceptLegal\":true}")"
  echo "   ${register_body}"
  echo "${register_body}" | grep -qi 'verification' || fail "register response unexpected"
  pass "register (${TEST_EMAIL})"

  echo ""
  echo "5. Login before verify (expect 403)"
  login_status="$(curl -sS -o /tmp/qtask-smoke-login.json -w "%{http_code}" \
    -X POST "${BASE_URL}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"smoke-test-pass\"}")"
  [[ "${login_status}" == "403" ]] || fail "login before verify returned ${login_status} (expected 403)"
  pass "login blocked until verified"
fi

echo ""
echo "All smoke checks passed."
echo ""
if [[ "${registration_enabled}" == "true" ]]; then
  echo "Next: verify the account to complete end-to-end testing."
  echo "  - Check your inbox if SMTP is configured"
  echo "  - Or read the verification link from logs:"
  echo "      sudo journalctl -u qtask -n 30 --no-pager | grep -i verify"
  echo ""
fi
echo "Then open ${BASE_URL} in a browser, sign in, and try creating a project/task."
