#!/usr/bin/env bash
##
## setup-git.sh
##
## Watch Hub Sync — One-Shot Git & GitHub Repository Initialisation.
##
## Run this script from inside the `cineroom/` directory:
##
##   cd /path/to/watchhubsync/cineroom
##   chmod +x setup-git.sh
##   ./setup-git.sh
##
## On Windows: run in Git Bash (ships with Git for Windows) or WSL2.
## Do NOT run in PowerShell — heredoc syntax will fail.
##
## Prerequisites:
##   - Git >= 2.39  (git --version)
##   - GitHub CLI   (gh --version) — install from https://cli.github.com
##                  OR skip to the MANUAL REMOTE section below
##   - pnpm         (pnpm --version) — install via: npm i -g pnpm
##
## The script will:
##   1. Verify prerequisites
##   2. Detect existing git history and abort if already initialised
##   3. Configure git identity (if not already set)
##   4. Add PostHog to package.json dependencies (required before first commit)
##   5. Initialise the repository with `main` as the default branch
##   6. Stage all files (honouring .gitignore)
##   7. Create a signed initial commit
##   8. Create a private GitHub repository and push via `gh` CLI
##   9. Print fallback manual commands if `gh` is unavailable
##
## ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail   # Exit on error, unset variable, or pipe failure
IFS=$'\n\t'         # Safer word splitting

## ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'  # No Colour

log_info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*"; }
log_section() { echo -e "\n${BOLD}══ $* ${NC}"; }

## ── Configuration — edit these before running ────────────────────────────────

# Your GitHub username or organisation name
GITHUB_OWNER="skhaj"  # ← CHANGE THIS to your GitHub username

# Repository name on GitHub
REPO_NAME="watchhubsync"

# Repository visibility: "private" recommended until launch
REPO_VISIBILITY="private"

# Repository description
REPO_DESCRIPTION="India-first watch-together synchronization platform"

# Primary branch name
PRIMARY_BRANCH="main"

## ── Guard: ensure we're in the right directory ───────────────────────────────
log_section "Pre-flight Checks"

if [[ ! -f "package.json" ]]; then
  log_error "package.json not found. Run this script from inside the cineroom/ directory."
  exit 1
fi

PROJECT_DIR=$(pwd)
log_ok "Working directory: ${PROJECT_DIR}"

## ── Guard: abort if git already initialised ──────────────────────────────────
if git rev-parse --is-inside-work-tree &>/dev/null; then
  log_warn "Git repository already initialised at: $(git rev-parse --show-toplevel)"
  log_warn "To re-run from scratch: rm -rf .git && ./setup-git.sh"
  exit 0
fi

## ── Prerequisite checks ──────────────────────────────────────────────────────
log_section "Checking Prerequisites"

# Git
if ! command -v git &>/dev/null; then
  log_error "git is not installed. Install from: https://git-scm.com"
  exit 1
fi
GIT_VERSION=$(git --version | awk '{print $3}')
log_ok "git ${GIT_VERSION}"

# Node.js
if ! command -v node &>/dev/null; then
  log_error "node is not installed. Install Node.js 20 LTS from: https://nodejs.org"
  exit 1
fi
log_ok "node $(node --version)"

# pnpm
if ! command -v pnpm &>/dev/null; then
  log_warn "pnpm not found. Installing globally..."
  npm install -g pnpm
fi
log_ok "pnpm $(pnpm --version)"

# GitHub CLI (optional but strongly recommended)
GH_AVAILABLE=false
if command -v gh &>/dev/null; then
  GH_AVAILABLE=true
  log_ok "gh $(gh --version | head -1)"

  # Check gh auth status
  if ! gh auth status &>/dev/null; then
    log_warn "GitHub CLI not authenticated. Running: gh auth login"
    gh auth login
  fi
else
  log_warn "GitHub CLI not found. Will print manual commands instead."
  log_warn "Install from: https://cli.github.com"
fi

## ── Step 1: Install dependencies (required before vitest can run in CI) ──────
log_section "Step 1: Install Dependencies"

# Add PostHog (required before first commit — CI will fail without it)
log_info "Adding posthog-js to dependencies..."
pnpm add posthog-js

# Add vitest + testing utilities (required for CI billing tests)
log_info "Adding vitest for billing unit tests..."
pnpm add -D vitest @vitejs/plugin-react jsdom @vitest/coverage-v8

# Add date-fns (used in dashboard page.tsx)
if ! grep -q '"date-fns"' package.json; then
  log_info "Adding date-fns..."
  pnpm add date-fns
fi

log_ok "Dependencies installed"

## ── Step 2: Add vitest config to package.json scripts ───────────────────────
log_section "Step 2: Configure Test Scripts"

# Check if vitest script already exists
if ! grep -q '"vitest"' package.json; then
  log_info "Adding vitest scripts to package.json..."
  # Use node to safely add scripts without corrupting JSON
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.scripts = pkg.scripts || {};
    pkg.scripts['vitest'] = 'vitest';
    pkg.scripts['test:billing'] = 'vitest run src/lib/billing/__tests__/meter-calculator.test.ts';
    pkg.scripts['test:watch'] = 'vitest watch';
    pkg.scripts['lint'] = pkg.scripts['lint'] || 'next lint';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log('package.json scripts updated');
  "
fi

# Create vitest.config.ts if it doesn't exist
if [[ ! -f "vitest.config.ts" ]]; then
  cat > vitest.config.ts << 'VITEST_CONFIG'
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals:     true,
    coverage: {
      provider:  "v8",
      reporter:  ["text", "json", "html"],
      include:   ["src/lib/billing/**/*.ts"],
      exclude:   ["src/lib/billing/__tests__/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
VITEST_CONFIG
  log_ok "vitest.config.ts created"
fi

## ── Step 3: Create .env.example ─────────────────────────────────────────────
log_section "Step 3: Create .env.example"

if [[ ! -f ".env.example" ]]; then
  cat > .env.example << 'ENV_EXAMPLE'
# ══════════════════════════════════════════════════════════════════════════════
# Watch Hub Sync — Environment Variables Reference
# Copy this file to .env.local and fill in real values.
# NEVER commit .env.local — it is in .gitignore.
# ══════════════════════════════════════════════════════════════════════════════

# ── Supabase ──────────────────────────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=your-supabase-jwt-secret-minimum-32-chars

# Database connections (see INFRASTRUCTURE.md for Supavisor setup)
DATABASE_URL=postgresql://postgres.YOUR_REF:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
DATABASE_URL_DIRECT=postgresql://postgres:PASSWORD@db.YOUR_REF.supabase.com:5432/postgres

# ── LiveKit ───────────────────────────────────────────────────────────────────
LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
NEXT_PUBLIC_LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxxxxxxxxxx
LIVEKIT_API_SECRET=your-livekit-api-secret-32-chars-minimum

# ── Stripe ────────────────────────────────────────────────────────────────────
STRIPE_SECRET_KEY=sk_test_YOUR_STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET=whsec_YOUR_STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_ID_PREMIUM=price_YOUR_PRICE_ID
STRIPE_METER_ID_PARTICIPANT_MINUTES=participant_minutes

# ── Razorpay ──────────────────────────────────────────────────────────────────
RAZORPAY_KEY_ID=rzp_test_YOUR_KEY_ID
RAZORPAY_KEY_SECRET=your-razorpay-key-secret
RAZORPAY_WEBHOOK_SECRET=your-razorpay-webhook-secret
RAZORPAY_PLAN_ID_PREMIUM=plan_YOUR_PLAN_ID

# ── Auth & Session ────────────────────────────────────────────────────────────
SVIX_WEBHOOK_SECRET=whsec_YOUR_SVIX_SECRET
IRON_SESSION_SECRET=your-iron-session-secret-minimum-32-chars-here

# ── Upstash Redis (rate limiting) ─────────────────────────────────────────────
UPSTASH_REDIS_REST_URL=https://YOUR_ENDPOINT.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...

# ── PostHog Analytics ─────────────────────────────────────────────────────────
NEXT_PUBLIC_POSTHOG_KEY=phc_YOUR_POSTHOG_PROJECT_API_KEY
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com

# ── Observability ─────────────────────────────────────────────────────────────
AXIOM_TOKEN=xaat-YOUR_AXIOM_TOKEN
AXIOM_DATASET=watchhubsync-production

# ── App ───────────────────────────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV_EXAMPLE
  log_ok ".env.example created (safe to commit)"
fi

## ── Step 4: Initialise git repository ───────────────────────────────────────
log_section "Step 4: Initialise Git Repository"

git init --initial-branch="${PRIMARY_BRANCH}"
log_ok "Git repository initialised (branch: ${PRIMARY_BRANCH})"

## ── Step 5: Configure git identity if missing ───────────────────────────────
log_section "Step 5: Git Identity"

GIT_EMAIL=$(git config --global user.email 2>/dev/null || echo "")
GIT_NAME=$(git config --global user.name 2>/dev/null || echo "")

if [[ -z "${GIT_EMAIL}" ]] || [[ -z "${GIT_NAME}" ]]; then
  log_warn "Git identity not configured globally."
  echo -n "  Enter your name for git commits: "
  read -r USER_NAME
  echo -n "  Enter your email for git commits: "
  read -r USER_EMAIL
  git config --local user.name  "${USER_NAME}"
  git config --local user.email "${USER_EMAIL}"
  log_ok "Git identity set locally for this repo"
else
  log_ok "Git identity: ${GIT_NAME} <${GIT_EMAIL}>"
fi

## ── Step 6: Configure git defaults ──────────────────────────────────────────
git config core.autocrlf false   # Prevents CRLF corruption on Windows
git config core.eol lf           # Enforce LF line endings in the repo
git config push.autoSetupRemote true  # git push works without -u on first push

## ── Step 7: Stage all files ──────────────────────────────────────────────────
log_section "Step 6: Stage Files"

log_info "Staging all files (honouring .gitignore)..."
git add --all

# Show what will be committed
STAGED_COUNT=$(git diff --cached --name-only | wc -l)
log_ok "Staged ${STAGED_COUNT} files"

if [[ "${STAGED_COUNT}" -eq 0 ]]; then
  log_error "No files staged. Is the cineroom/ directory populated?"
  exit 1
fi

# Safety check: ensure no .env files with real secrets snuck in
if git diff --cached --name-only | grep -E '^\.env($|\.)' | grep -v '\.example'; then
  log_error "SECURITY: A .env file with potential secrets is staged."
  log_error "Run: git reset HEAD .env* && git rm --cached .env*"
  exit 1
fi

log_ok "No secret .env files detected in staged files ✓"

## ── Step 8: Initial commit ───────────────────────────────────────────────────
log_section "Step 7: Initial Commit"

git commit --message "feat: Watch Hub Sync — Phases 1–7 initial commit

- Phase 1: Database schema, migrations, RLS policies
- Phase 2: Supabase SSR auth, Edge middleware, FIDO2/WebAuthn passkey service
- Phase 3: Cinematic dark UI — Tailwind, layouts, login, dashboard, room shell
- Phase 4: LiveKit WebRTC sync engine, OTT adapter engine (zero-proxy)
- Phase 5: Server-authoritative billing — LiveKit/Stripe/Razorpay webhooks
- Phase 6: Env validation (Zod), telemetry (Axiom), CI/CD (GitHub Actions)
- Phase 7: PostHog analytics, DNS cutover guide, production launch ops

Zero-proxy mandate: no video/audio bytes are proxied through this service.
All DRM-protected content is served directly by OTT platforms to viewers."

COMMIT_SHA=$(git rev-parse --short HEAD)
log_ok "Initial commit created: ${COMMIT_SHA}"

## ── Step 9: Create GitHub repository and push ────────────────────────────────
log_section "Step 8: GitHub Repository"

if [[ "${GH_AVAILABLE}" == "true" ]]; then
  log_info "Creating GitHub repository: ${GITHUB_OWNER}/${REPO_NAME} (${REPO_VISIBILITY})"

  gh repo create "${REPO_NAME}" \
    --"${REPO_VISIBILITY}" \
    --description "${REPO_DESCRIPTION}" \
    --source=. \
    --remote=origin \
    --push

  REPO_URL="https://github.com/${GITHUB_OWNER}/${REPO_NAME}"
  log_ok "Repository created and pushed: ${REPO_URL}"

  # Enable GitHub Actions (already in .github/workflows/ci.yml)
  log_info "Verifying GitHub Actions workflow..."
  gh workflow list --repo "${GITHUB_OWNER}/${REPO_NAME}" 2>/dev/null || true

  # Configure branch protection on main
  log_info "Configuring branch protection on 'main'..."
  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "/repos/${GITHUB_OWNER}/${REPO_NAME}/branches/${PRIMARY_BRANCH}/protection" \
    --field required_status_checks='{"strict":true,"contexts":["Type Check & Lint","Billing Unit Tests (meter-calculator)","Next.js Build Gate"]}' \
    --field enforce_admins=false \
    --field required_pull_request_reviews='{"required_approving_review_count":1}' \
    --field restrictions=null \
    2>/dev/null || log_warn "Branch protection requires GitHub Pro/Team — skip for personal repos"

else
  ## ── FALLBACK: Manual commands when gh CLI is unavailable ─────────────────
  echo ""
  echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║  GitHub CLI not available — complete manually:               ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  1. Create the repository on GitHub:"
  echo "     → https://github.com/new"
  echo "     → Name: ${REPO_NAME}"
  echo "     → Visibility: ${REPO_VISIBILITY}"
  echo "     → DO NOT initialise with README, .gitignore, or license"
  echo "       (the repo is already initialised locally)"
  echo ""
  echo "  2. Run these commands in your terminal:"
  echo ""
  echo -e "${BOLD}     git remote add origin https://github.com/${GITHUB_OWNER}/${REPO_NAME}.git${NC}"
  echo -e "${BOLD}     git branch -M ${PRIMARY_BRANCH}${NC}"
  echo -e "${BOLD}     git push -u origin ${PRIMARY_BRANCH}${NC}"
  echo ""
  echo "  3. (Optional) SSH instead of HTTPS:"
  echo -e "${BOLD}     git remote set-url origin git@github.com:${GITHUB_OWNER}/${REPO_NAME}.git${NC}"
  echo ""
fi

## ── Step 10: Post-push summary ───────────────────────────────────────────────
log_section "Complete"

echo ""
log_ok "Git repository initialised and pushed to GitHub."
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Set environment variables in Vercel Dashboard"
echo "     (see INFRASTRUCTURE.md → Section 2.3)"
echo ""
echo "  2. Connect the GitHub repo to Vercel:"
echo "     → https://vercel.com/new"
echo "     → Import: ${GITHUB_OWNER}/${REPO_NAME}"
echo "     → Root Directory: cineroom/"
echo ""
echo "  3. Execute the DNS cutover:"
echo "     → Read LAUNCH_OPS.md in full before touching GoDaddy"
echo ""
echo "  4. Set up PostHog project at https://app.posthog.com"
echo "     → Copy the Project API Key (phc_...)"
echo "     → Set NEXT_PUBLIC_POSTHOG_KEY in Vercel Dashboard"
echo ""
