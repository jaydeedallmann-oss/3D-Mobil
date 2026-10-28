# Gewässer-3D mobil (PWA)

Handy-App, die Gewässerpakete (`.uwpaket`) aus dem Desktop-Tool **Unterwasserwelt 3D** offline als
3D-Relief mit Luftbild anzeigt – mit GPS-Standort, Tiefe unter mir und eigenen Hotspots.

Version 0.1.0 · komplett offline · keine Server · keine Messdaten verlassen das Gerät.

## Lokal testen (sofort, ohne Veröffentlichen)
`index.html` im Chrome öffnen (Doppelklick). 3D-Ansicht, Paket-Import und Hotspots funktionieren schon über `file://`.
**GPS, Installieren („Zum Startbildschirm“) und der Offline-Service-Worker brauchen HTTPS** – dafür auf GitHub Pages veröffentlichen.

## Auf GitHub Pages veröffentlichen (einmalig, ~3 Minuten)

### Variante A – ohne Git, nur im Browser (am einfachsten)
1. Auf github.com einloggen → oben rechts **+ → New repository**.
2. Name z. B. `gewaesser-3d-mobil`, **Public**, **Create repository**.
3. Auf der leeren Repo-Seite: **„uploading an existing file“** anklicken.
4. **Alle Dateien und den `lib/`-Ordner** aus diesem Ordner per Drag-and-drop hochladen (Struktur beibehalten: `lib/` muss `lib/` bleiben). **Commit changes**.
5. Reiter **Settings → Pages**: unter *Branch* `main` + `/ (root)` wählen, **Save**.
6. Nach ~1 Minute erscheint oben die Adresse, z. B. `https://<deinname>.github.io/gewaesser-3d-mobil/`.

### Variante B – mit Git (falls installiert)
```
cd gewaesser-mobil
git init && git add . && git commit -m "Gewässer-3D mobil 0.1.0"
git branch -M main
git remote add origin https://github.com/<deinname>/gewaesser-3d-mobil.git
git push -u origin main
```
Danach **Settings → Pages → Branch `main` / root → Save** wie oben.

## Aufs Handy bringen
1. Die GitHub-Pages-Adresse im **Chrome auf dem Android-Handy** öffnen.
2. Chrome-Menü → **„Zum Startbildschirm hinzufügen“** / **„App installieren“**.
3. App vom Startbildschirm starten – läuft danach **offline**.
4. In der App: **☰ → Gewässerpaket laden** und die `.uwpaket`-Datei wählen (vom Handy-Speicher; per Kabel/Cloud/Mail aufs Handy bringen).

## Paket erzeugen (Desktop)
Im Tool **Unterwasserwelt 3D** (ab 0.17.0): **Export → „Gewässerpaket fürs Handy“** → `.uwpaket` speichern.

## Enthaltene Fremdbibliotheken
- three.js (MIT) – `lib/three.min.js`, Lizenz `lib/THREE-LICENSE`
Luftbild © Geobasis NRW bzw. PDOK (Beeldmateriaal.nl). Nur zur Orientierung, nicht zur Navigation.
