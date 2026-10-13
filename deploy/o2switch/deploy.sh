#!/usr/bin/env bash
# Déploie TranspoZ (version web avec reconnaissance) sur un hébergement o2switch,
# ou le met à jour : ./deploy/o2switch/deploy.sh
#
# Prérequis : config.sh (voir config.example.sh), connexion SSH par clé (IP en liste
# blanche dans cPanel → « Autorisation SSH »), sous-domaine créé dans cPanel dont le
# dossier racine est ~/$O2SWITCH_DIR, certificat HTTPS (cPanel → « Let's Encrypt SSL »).
# Voir README.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
if [ ! -f "$HERE/config.sh" ]; then
  echo "Copier deploy/o2switch/config.example.sh en config.sh et l'adapter." >&2
  exit 1
fi
# shellcheck source=config.example.sh
source "$HERE/config.sh"

SSH=(ssh -4 -o BatchMode=yes "$O2SWITCH_SSH")
RSYNC=(rsync -a -e "ssh -4 -o BatchMode=yes")
APP="$O2SWITCH_DIR/app"
VENV="virtualenv/$APP/${O2SWITCH_PYTHON%.*}"
step() { printf '\n== %s\n' "$*"; }

step "Préparation de l'application"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r "$ROOT/server" "$ROOT/web" "$STAGE/"
rm -f "$STAGE"/web/_*
find "$STAGE" -name __pycache__ -prune -exec rm -rf {} +
mkdir -p "$STAGE/node_modules/opensheetmusicdisplay/build"
cp "$ROOT/node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js" "$STAGE/node_modules/opensheetmusicdisplay/build/"
{ cat "$ROOT/requirements.txt"; echo "a2wsgi>=1.10"; } > "$STAGE/requirements.txt"
cp "$HERE/passenger_wsgi.py" "$STAGE/"

step "Audiveris (Linux, Java compris)"
AUD="$ROOT/desktop/vendor/audiveris-linux"
[ -f "$AUD/.version" ] || node "$ROOT/desktop/scripts/fetch-audiveris.mjs" linux
local_version="$(cat "$AUD/.version")"
remote_version="$("${SSH[@]}" "cat $O2SWITCH_DIR/audiveris/.version 2>/dev/null || true")"
if [ "$remote_version" = "$local_version" ]; then
  echo "Audiveris $local_version déjà en place."
else
  echo "Envoi d'Audiveris $local_version (environ 190 Mo)…"
  "${RSYNC[@]}" --delete "$AUD/" "$O2SWITCH_SSH:$O2SWITCH_DIR/audiveris/"
fi
"${RSYNC[@]}" --chmod=F755 "$HERE/audiveris.sh" "$O2SWITCH_SSH:$O2SWITCH_DIR/"

step "Envoi du code"
# public/ et tmp/ appartiennent à Passenger (redémarrage), ne pas y toucher.
# Droits imposés : Apache/Passenger doivent pouvoir lire (le dossier temporaire local est en 700).
"${RSYNC[@]}" --delete --exclude /public/ --exclude /tmp/ --chmod=D755,F644 "$STAGE/" "$O2SWITCH_SSH:$APP/"

step "Application Python, dépendances, redémarrage"
"${SSH[@]}" bash -s <<EOF
set -euo pipefail
if [ ! -x ~/$VENV/bin/python ]; then
  echo "Première installation : création de l'application Python $O2SWITCH_PYTHON sur $O2SWITCH_DOMAIN"
  cp ~/$APP/passenger_wsgi.py /tmp/transpoz-passenger_wsgi.py
  cloudlinux-selector create --json --interpreter python --version $O2SWITCH_PYTHON --app-root $APP \\
    --domain $O2SWITCH_DOMAIN --app-uri / --startup-file passenger_wsgi.py --entry-point application
  # L'outil remplace passenger_wsgi.py par un modèle : on remet le nôtre.
  mv /tmp/transpoz-passenger_wsgi.py ~/$APP/passenger_wsgi.py
fi
~/$VENV/bin/pip install -q --disable-pip-version-check -r ~/$APP/requirements.txt
# Le dossier racine du sous-domaine contient aussi le code et Audiveris : seule l'application répond.
if ! grep -q "TranspoZ : ce dossier" ~/$O2SWITCH_DIR/.htaccess 2>/dev/null; then
  cat >> ~/$O2SWITCH_DIR/.htaccess <<'HTACCESS'

# TranspoZ : ce dossier contient aussi le code (app/), Audiveris et des fichiers de test.
# Rien de tout cela n’est servi directement : seule l’application répond.
RedirectMatch 404 ^/(app|audiveris|partitions|sortie|tessdata-vide)(/.*)?$
RedirectMatch 404 ^/audiveris\.sh$
HTACCESS
fi
cloudlinux-selector restart --json --interpreter python --app-root $APP > /dev/null
EOF

step "Vérification"
status="$(curl -fsS --max-time 60 "https://$O2SWITCH_DOMAIN/api/status")"
echo "https://$O2SWITCH_DOMAIN/api/status → $status"
case "$status" in
  *'"engine":"audiveris"'*) echo "TranspoZ est à jour sur https://$O2SWITCH_DOMAIN/" ;;
  *) echo "Attention : Audiveris n'est pas détecté par le serveur." >&2; exit 1 ;;
esac
