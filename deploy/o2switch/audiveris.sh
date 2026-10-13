#!/bin/bash
# Lance Audiveris (Java embarqué) sur un serveur sans écran (o2switch, CloudLinux 8) :
# - GDK_SCALE et mode headless : Audiveris ne cherche pas la bibliothèque graphique GTK ;
# - useOCR=false : pas de lecture de texte (module natif trop récent pour la glibc 2.28,
#   et inutile pour TranspoZ) ;
# - mémoire plafonnée à 2 Go et 4 cœurs : largement suffisant pour une partition.
DIR="$(dirname "$(readlink -f "$0")")"
A="$DIR/audiveris/lib"
CP=$(grep '^app.classpath=' "$A/app/Audiveris.cfg" | sed "s|^app.classpath=\$APPDIR|$A/app|" | paste -sd:)
mapfile -t OPTS < <(grep '^java-options=' "$A/app/Audiveris.cfg" | sed 's|^java-options=||; s|-Xmx8G|-Xmx2G|')
mkdir -p "$DIR/tessdata-vide"
export GDK_SCALE=1 TESSDATA_PREFIX="$DIR/tessdata-vide"
exec "$A/runtime/bin/java" "${OPTS[@]}" -XX:ActiveProcessorCount=4 -Dsun.java2d.uiScale=1 -Djava.awt.headless=true \
  -cp "$CP" Audiveris -constant org.audiveris.omr.text.tesseract.TesseractOCR.useOCR=false "$@"
