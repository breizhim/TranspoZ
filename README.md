# TranspoZ

Outil en ligne pour **transposer une partition** fournie en PDF ou en image (JPG, PNG) :

1. on dépose la partition, on indique le **morceau**, l'**instrument** et sa **hauteur** (Ut, Si♭, Mi♭, Fa…) ;
2. le serveur **reconnaît les notes** (reconnaissance optique de partitions, « OMR ») et produit un fichier MusicXML ;
3. on choisit la **transposition** (instrument cible et/ou changement de tonalité) : la partition se met à jour **en direct** dans le navigateur ;
4. on l'**imprime** (ou on l'enregistre en PDF via la boîte d'impression), ou on télécharge le MusicXML pour la retoucher dans MuseScore.

## Fonctionnalités

- Import PDF (plusieurs pages), JPG/PNG (plusieurs fichiers = plusieurs pages), ou MusicXML (`.musicxml`, `.xml`, `.mxl`) directement.
- Catalogue d'instruments (clarinettes, saxophones, trompettes, cor en Fa, cuivres en clé de sol, cordes, guitare…) et hauteur/octave personnalisables.
- Transposition « vers un instrument » (ex. partie de flûte → clarinette en Si♭) combinable avec un changement de tonalité par demi-tons.
- Orthographe musicale correcte : armure recalculée (au plus 6 altérations, préférence ♯/♭ au choix), altérations accidentelles recalculées mesure par mesure, accords chiffrés transposés.
- Changement de clé optionnel (ex. trombone en clé de fa → trompette en clé de sol).
- Affichage de l'original à côté pour vérifier la reconnaissance.
- Impression au format A4 (seule la partition est imprimée).

## Architecture

```
web/                 interface (HTML/CSS/JS, sans framework)
  transpose.js       moteur de transposition MusicXML (JS pur, testé sous Node)
  instruments.js     hauteurs et catalogue d'instruments
  app.js             interface, rendu avec OpenSheetMusicDisplay, impression
  mxl.js             lecture MusicXML / .mxl dans le navigateur
  config.js          adresse du serveur de reconnaissance
server/              API FastAPI
  main.py            POST /api/recognize, GET /api/status, fichiers statiques
  omr.py             moteurs de reconnaissance (Audiveris, oemer)
  musicxml.py        lecture .mxl, fusion des pages
tests/               tests Node (transposition) et pytest (API)
```

La transposition se fait entièrement dans le navigateur : une fois la partition reconnue, chaque changement de réglage est instantané, sans aller-retour avec le serveur.

## Reconnaissance des notes (OMR)

La reconnaissance est déléguée à un moteur libre, installé sur le serveur :

| Moteur | Points forts | Installation |
|---|---|---|
| [Audiveris](https://github.com/Audiveris/audiveris) | Meilleur sur les partitions imprimées (PDF, scans) | paquet `.deb`/installeur de la page *Releases* ; ou variable `AUDIVERIS_CMD` |
| [oemer](https://github.com/BreezeWhite/oemer) | Plus tolérant avec les photos de téléphone | `pip install oemer` (modèles téléchargés au 1er usage) |

`OMR_ENGINE=auto` (défaut) utilise Audiveris s'il est présent, sinon oemer. On peut forcer `OMR_ENGINE=audiveris` ou `OMR_ENGINE=oemer`.

Aucune reconnaissance n'est parfaite : les partitions manuscrites, les photos floues ou de travers donnent des erreurs. Pour de meilleurs résultats, utilisez un PDF d'origine ou un scan à 300 dpi, bien droit. Le bouton « Original » permet de comparer, et le MusicXML exporté peut être corrigé dans MuseScore puis réimporté.

Autres variables : `OMR_TIMEOUT` (secondes, défaut 600), `OMR_PDF_DPI` (défaut 300, pour oemer), `MAX_UPLOAD_MB` (défaut 25).

## Lancer en local

```bash
npm install                        # OpenSheetMusicDisplay (affichage des partitions)
pip install -r requirements.txt
pip install oemer                  # et/ou installer Audiveris
uvicorn server.main:app --reload   # http://localhost:8000
```

Sans moteur OMR, l'outil fonctionne quand même avec des fichiers MusicXML (et le bouton « Essayer avec un exemple »).

## GitHub Pages

Le site est publié sur **https://breizhim.github.io/TranspoZ/** par le workflow `.github/workflows/pages.yml`, à chaque push sur la branche par défaut (tests, puis `scripts/build-pages.sh`, puis déploiement).

Activation (une seule fois) : **Settings → Pages → Build and deployment → Source : « GitHub Actions »**, puis relancer le workflow (onglet *Actions* → *GitHub Pages* → *Run workflow*).

GitHub Pages n'héberge que des fichiers statiques : la transposition, l'affichage, l'impression et l'import MusicXML/.mxl fonctionnent entièrement dans le navigateur, mais **la reconnaissance des PDF/JPG a besoin du serveur Python**. Pour l'activer sur la version Pages :

1. déployer le serveur (image Docker ci-dessous) chez un hébergeur : Hugging Face Spaces (Docker, `PORT=7860`), Render, Fly.io, un VPS… ;
2. créer la variable de dépôt `OMR_API_URL` (**Settings → Secrets and variables → Actions → Variables**) avec l'adresse du serveur, ex. `https://mon-transpoz.hf.space` ;
3. relancer le workflow. Le serveur accepte les appels d'autres sites (CORS) ; on peut les restreindre avec `CORS_ORIGINS=https://breizhim.github.io`.

Construction locale de la version statique : `npm ci && OMR_API_URL=... ./scripts/build-pages.sh` (résultat dans `_site/`).

## Docker

```bash
docker build -t transpoz .                     # avec oemer
docker build -t transpoz \
  --build-arg AUDIVERIS_DEB_URL=<url du .deb Audiveris> .   # avec Audiveris en plus
docker run -p 8000:8000 transpoz
```

La variable `PORT` change le port d'écoute (ex. `PORT=7860` pour Hugging Face Spaces).

## Tests

```bash
npm test                                   # transposition (Node ≥ 20)
pip install -r requirements-dev.txt && pytest
```
