#!/usr/bin/env bash
# Sincronizza il fork aion-cowork con upstream/main (OpenCoworkAI/open-cowork).
# Crea un branch sync/upstream-AAAA-MM-GG dal branch corrente e avvia un merge senza commit.
set -euo pipefail

usage() {
  cat <<'EOF'
Uso: scripts/sync-upstream.sh [--dry-run] [-h|--help]

Passi:
  1. Verifica che il working tree (file tracciati) sia pulito.
  2. git fetch upstream.
  3. Stampa quanti commit upstream mancano e il report di rischio conflitti:
     i file modificati upstream che compaiono anche in FORK_TOUCHPOINTS.md.
  4. Crea il branch sync/upstream-AAAA-MM-GG dal branch corrente.
  5. git merge --no-ff --no-commit upstream/main.
     In caso di conflitti stampa i file coinvolti e le istruzioni per risolverli.

Opzioni:
  --dry-run   Stampa solo il report (passi 1-3). Nessun branch creato, nessun merge.
              Il fetch viene comunque eseguito, per avere upstream/main aggiornato.
  -h, --help  Mostra questo messaggio.

I test non vengono eseguiti automaticamente: lanciare "npm test" a mano dopo il merge.
EOF
}

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "Argomento sconosciuto: $1" >&2; usage >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TOUCHPOINTS="FORK_TOUCHPOINTS.md"
UPSTREAM_REF="upstream/main"

# 0. Prerequisiti
if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "ERRORE: remote 'upstream' non configurato." >&2
  echo "Aggiungilo con: git remote add upstream https://github.com/OpenCoworkAI/open-cowork.git" >&2
  exit 1
fi

# 1. Working tree pulito (i file non tracciati non bloccano il merge)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERRORE: working tree non pulito. Committa o stasha le modifiche prima di sincronizzare:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

# 2. Fetch da upstream
echo "==> git fetch upstream"
git fetch upstream

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SYNC_BRANCH="sync/upstream-$(date +%F)"
MERGE_BASE="$(git merge-base HEAD "$UPSTREAM_REF")"

# 3. Report
BEHIND="$(git log --oneline HEAD.."$UPSTREAM_REF" | wc -l | tr -d ' ')"
echo ""
echo "==> Report sincronizzazione"
echo "Branch corrente:        $CURRENT_BRANCH"
echo "Branch di sync previsto: $SYNC_BRANCH"
echo "Commit upstream da integrare: $BEHIND"

if [ "$BEHIND" -eq 0 ]; then
  echo "Nessun commit nuovo su $UPSTREAM_REF. Nulla da fare."
  exit 0
fi

# File modificati upstream dal merge-base, e file dichiarati nel documento dei touchpoint
UPSTREAM_CHANGED_FILE="$(mktemp)"
DECLARED_FILE="$(mktemp)"
trap 'rm -f "$UPSTREAM_CHANGED_FILE" "$DECLARED_FILE"' EXIT

git diff --name-only "$MERGE_BASE" "$UPSTREAM_REF" | sort -u > "$UPSTREAM_CHANGED_FILE"
{ grep -o '`[^`]*`' "$TOUCHPOINTS" 2>/dev/null || true; } | tr -d '`' | sort -u > "$DECLARED_FILE"

RISK_FILES="$(comm -12 "$UPSTREAM_CHANGED_FILE" "$DECLARED_FILE" || true)"

echo ""
echo "File modificati upstream che anche noi abbiamo modificato (rischio conflitto):"
if [ -n "$RISK_FILES" ]; then
  printf '%s\n' "$RISK_FILES" | sed 's/^/  - /'
else
  echo "  nessuno"
fi
echo ""
echo "File modificati upstream in totale: $(wc -l < "$UPSTREAM_CHANGED_FILE" | tr -d ' ')"

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "Dry run: nessun branch creato, nessun merge eseguito."
  exit 0
fi

# 4. Branch di sincronizzazione
if git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
  echo "ERRORE: il branch $SYNC_BRANCH esiste gia'. Rinominalo o eliminalo prima di rieseguire." >&2
  exit 1
fi

echo ""
echo "==> Creo il branch $SYNC_BRANCH da $CURRENT_BRANCH"
git checkout -b "$SYNC_BRANCH"

# 5. Merge senza commit
echo "==> git merge --no-ff --no-commit $UPSTREAM_REF"
if git merge --no-ff --no-commit "$UPSTREAM_REF"; then
  echo ""
  echo "Merge completato senza conflitti (non ancora committato)."
  echo "Controlla le modifiche con: git status && git diff --cached"
else
  echo ""
  echo "CONFLITTI nei file seguenti:"
  git diff --name-only --diff-filter=U | sed 's/^/  - /'
  cat <<EOF

Come risolvere:
  1. Apri ogni file in conflitto e mantieni gli hook-in AION (branding, preset, overlay Enterprise).
  2. Per ogni file risolto: git add <file>
  3. Verifica i touchpoint: npm run check:fork (aggiorna FORK_TOUCHPOINTS.md se serve).
  4. Esegui i test: npm test (non lanciati automaticamente).
  5. Concludi il merge: git commit
  Per annullare il merge: git merge --abort
EOF
  exit 1
fi

echo ""
echo "Prossimi passi:"
echo "  - Esegui i test: npm test (non lanciati automaticamente)"
echo "  - Esegui il controllo touchpoint: npm run check:fork"
echo "  - Poi committa il merge con: git commit"
