#!/bin/bash
# Désinstallation du paquet .rpm (remplace le script par défaut d'electron-builder).
#
# rpm lance ce script avec $1 = 0 pour une vraie désinstallation, et $1 = 1 lors
# d'une mise à jour ou d'une réinstallation — APRÈS l'installation du nouveau
# paquet. Le script par défaut supprimait alors le lien /usr/bin/transpoz que le
# nouveau paquet venait de créer. On ne fait donc rien sauf à la désinstallation.
if [ "$1" != "0" ]; then
  exit 0
fi

if type update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove 'transpoz' '/opt/TranspoZ/transpoz'
else
  rm -f '/usr/bin/transpoz'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/transpoz'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
