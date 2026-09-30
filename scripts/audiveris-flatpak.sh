#!/usr/bin/env bash
# Lance Audiveris installé en Flatpak (org.audiveris.audiveris) comme une
# commande ordinaire, pour le serveur de TranspoZ.
#
# Le Flatpak a un système de fichiers isolé (et son propre /tmp) : on lui
# ouvre le dossier de sortie (-output) et le dossier de chaque fichier
# d'entrée, qui sont dans le dossier temporaire du serveur.
#
# Utilisation : AUDIVERIS_CMD=/chemin/vers/audiveris-flatpak.sh
#          ou : ln -s "$PWD/scripts/audiveris-flatpak.sh" ~/.local/bin/audiveris
set -euo pipefail

app=org.audiveris.audiveris
perms=()
prev=""
after_dashes=0
for arg in "$@"; do
  if [[ $prev == "-output" ]]; then
    perms+=("--filesystem=$(realpath -m "$arg")")
  elif (( after_dashes )) && [[ -e $arg ]]; then
    perms+=("--filesystem=$(dirname "$(realpath "$arg")")")
  fi
  [[ $arg == "--" ]] && after_dashes=1
  prev=$arg
done

exec flatpak run "${perms[@]}" "$app" "$@"
