#!/bin/sh
# Construit la version statique (GitHub Pages) dans _site/.
# Prérequis : npm ci. Variable facultative : OMR_API_URL (serveur de reconnaissance).
set -eu
rm -rf _site
mkdir -p _site/vendor/osmd
cp -R web/. _site/
cp node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js _site/vendor/osmd/
node -e 'const url = process.env.OMR_API_URL || ""; process.stdout.write(
  "window.TRANSPOZ_CONFIG = { apiUrl: " + JSON.stringify(url) + " };\n")' > _site/config.js
touch _site/.nojekyll
echo "Site statique construit dans _site/ (serveur OMR : ${OMR_API_URL:-aucun})"
