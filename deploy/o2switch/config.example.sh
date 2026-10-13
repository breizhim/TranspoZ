# Configuration du déploiement sur o2switch : copier en config.sh (non suivi par git) et adapter.
O2SWITCH_SSH="identifiant@adresse-du-serveur"   # connexion SSH (clé autorisée, IP en liste blanche)
O2SWITCH_DOMAIN="transpoz.example.org"          # sous-domaine de l'application (dossier racine : ~/$O2SWITCH_DIR)
O2SWITCH_DIR="transpoz-test"                    # dossier de l'application dans le compte
O2SWITCH_PYTHON="3.12.15"                       # version Python de l'application (cloudlinux-selector)
