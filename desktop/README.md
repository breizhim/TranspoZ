# TranspoZ — application de bureau

La même application que la version web, **sans serveur à lancer** : Audiveris
(reconnaissance des partitions) est livré dedans, avec son Java.

## Installer

Télécharger le fichier de la dernière version (page *Releases* du dépôt) :

| Système | Fichier | Installation |
|---|---|---|
| Fedora, openSUSE… | `TranspoZ-x.y.z-linux-x86_64.rpm` | double-clic, ou `sudo dnf install ./TranspoZ-….rpm` |
| Ubuntu, Debian… | `TranspoZ-x.y.z-linux-amd64.deb` | double-clic, ou `sudo apt install ./TranspoZ-….deb` |
| Toute distribution | `TranspoZ-x.y.z-linux-x86_64.AppImage` | rendre exécutable puis lancer ; demande la bibliothèque FUSE 2 (`fuse-libs` / `libfuse2`), sinon : `./TranspoZ-….AppImage --appimage-extract-and-run` |
| Windows 10 / 11 | `TranspoZ-x.y.z-win-x64.exe` | installateur |

## Fonctionnement

- `main.mjs` (Electron) sert l'interface du dossier `../web` **sans la modifier** et,
  pour les PDF et les images, lance l'Audiveris embarqué ; la fusion des pages se fait
  dans l'interface (`web/merge.js`). Toute évolution de `web/` profite donc aux deux versions.
- `preload.cjs` expose ce pont à l'interface (`window.transpozDesktop`).
- La lecture de texte (OCR) d'Audiveris est désactivée (`TESSDATA_PREFIX` vide) : elle
  ajoutait des textes incohérents et faisait perdre des nuances.

## Développer et construire

```bash
npm ci                      # à la racine du dépôt (OpenSheetMusicDisplay, tests)
cd desktop && npm ci
npm run fetch-audiveris     # télécharge Audiveris dans vendor/ (une fois)
npm start                   # lance l'application (interface lue directement dans ../web)

npm run dist:linux          # dist/ : AppImage, .deb, .rpm (rpm-build et une libcrypt.so.1 nécessaires)
npm run dist:win            # sous Windows : installateur .exe
```

Le workflow `.github/workflows/desktop.yml` construit Linux et Windows, vérifie
l'application construite (auto-test : reconnaissance de `test/partition.png`) et joint
les fichiers à la publication GitHub à chaque tag `v*`.

Auto-test à la main : `TRANSPOZ_SELFTEST=chemin/partition.png dist/linux-unpacked/transpoz`.

Licences des logiciels livrés : voir `THIRD_PARTY.md` (Audiveris est sous AGPL-3.0).
