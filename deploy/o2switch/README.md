# TranspoZ sur o2switch (hébergement mutualisé)

Version web complète (interface + reconnaissance par Audiveris) sur une offre o2switch
(testée sur l'Offre Unique Cloud : CloudLinux 8, Passenger, Python 3.12).

## Mise à jour

```bash
./deploy/o2switch/deploy.sh
```

Envoie le code (`server/`, `web/`, OpenSheetMusicDisplay), Audiveris s'il a changé, met à jour
les dépendances Python, redémarre l'application et vérifie qu'elle répond.

## Première installation

1. **SSH** : clé autorisée dans cPanel → « Accès SSH », adresse IP ajoutée dans
   cPanel → « Autorisation SSH » (liste blanche ; `ssh -4` si la connexion a aussi de l'IPv6).
2. **Sous-domaine** : cPanel → « Domaines », dossier racine `transpoz-test` (ou autre, voir `O2SWITCH_DIR`).
3. **HTTPS** : cPanel → « Let's Encrypt™ SSL » pour ce sous-domaine (AutoSSL n'est pas proposé).
4. `cp deploy/o2switch/config.example.sh deploy/o2switch/config.sh`, l'adapter, puis lancer `deploy.sh` :
   au premier passage, il crée l'application Python (`cloudlinux-selector`).

## Particularités d'o2switch

- **Passenger n'accepte que WSGI** : `passenger_wsgi.py` enveloppe le serveur FastAPI (ASGI) avec `a2wsgi`.
  L'outil d'o2switch remplace ce fichier par un modèle à la création : `deploy.sh` remet le nôtre.
- **Audiveris** (Linux, Java compris) est lancé par `audiveris.sh` :
  - `GDK_SCALE=1` et mode headless : sinon il cherche la bibliothèque graphique GTK, absente du serveur ;
  - `useOCR=false` : son module de lecture de texte demande une glibc 2.34, le serveur a la 2.28 ;
    de toute façon inutile (et nuisible) pour TranspoZ ;
  - mémoire plafonnée à 2 Go, 4 cœurs : une reconnaissance prend 10 à 15 s et 600 à 900 Mo.
- **Dossier racine = dossier de l'application** : le `.htaccess` refuse l'accès direct à `app/`,
  `audiveris/` et `audiveris.sh` ; seule l'application répond. (Plus propre : dossier racine
  du sous-domaine en `transpoz-test/public` dans cPanel.)
- **ModSecurity** reste actif : il laisse passer les envois des navigateurs. Il bloque en revanche
  les envois « nus » (ex. `curl -F` sans en-têtes de navigateur), redirigés vers `/406.shtml`.
- Lancé depuis une session SSH, Audiveris est parfois arrêté par l'hébergeur ; lancé par
  l'application web, il ne l'a jamais été lors des essais.
