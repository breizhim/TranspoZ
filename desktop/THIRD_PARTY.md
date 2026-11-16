# Logiciels tiers livrés avec TranspoZ

## Audiveris

TranspoZ livre Audiveris pour la reconnaissance des partitions (PDF, images).
Audiveris est un programme distinct, appelé en ligne de commande ; il n'est pas modifié.

- Licence : GNU Affero General Public License v3.0 (AGPL-3.0)
- Code source : https://github.com/Audiveris/audiveris
- Version livrée : voir le fichier `audiveris/.version` dans les ressources de l'application.

Audiveris inclut un environnement Java (OpenJDK, GPL v2 avec exception « Classpath ») ;
ses licences sont dans `audiveris/lib/runtime/legal/` (Linux) ou `audiveris/runtime/legal/` (Windows).

## Sons des instruments (Versilian Studios)

Lecture de la partition. Enregistrements dans le domaine public (CC0 1.0), convertis par
`scripts/prepare-samples.py` :
- trompette, flûte traversière, clarinette : VSCO 2 Community Edition — https://github.com/sgossner/VSCO-2-CE
- piano à queue (Kawai), saxophone ténor : Versilian Community Sample Library — https://github.com/sgossner/VCSL

## OpenSheetMusicDisplay

Affichage des partitions. Licence BSD-3-Clause — https://github.com/opensheetmusicdisplay/opensheetmusicdisplay

## Electron

Application de bureau. Licence MIT — https://github.com/electron/electron
