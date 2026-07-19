# Geo Scores Autofill

Brücke zwischen geotrivia.com und dem Geo-Scores-Webformular (Apps Script).

## Warum ein Userscript?

Das Formular läuft auf `*.googleusercontent.com` und darf wegen der
Same-Origin-Policy/CORS nicht selbst `geotrivia.com` abrufen. Die
GeoRankle-Ergebnisse werden bei geotrivia über einen Account synchronisiert
(better-auth, HttpOnly-Session-Cookie) und serverseitig in die Seite
eingebettet – es gibt keinen separaten Ergebnis-API-Endpoint und kein im JS
lesbares Token. `GM_xmlhttpRequest` umgeht CORS mit Erweiterungsrechten und
schickt die geotrivia-Cookies automatisch mit; damit bekommt das Skript genau
die synchronisierten Ergebnisse des eingeloggten Accounts – auf jedem Rechner,
auch wenn dort nicht gespielt wurde.

## Ablauf

1. Formular: Klick auf den Zauberstab hinter „Heutige Scores" feuert das
   DOM-Event `geoscores-autofill-anfrage`.
2. Userscript (läuft im Apps-Script-Sandbox-iframe): holt pro Spiel die
   geotrivia-Seite (jede bettet nur ihr eigenes `serverGameResult` ein;
   georankle, geoconnections, geodecide, geopaint, geodle – parallel), setzt
   jeweils den `self.__next_f.push`-Stream zusammen und parst
   `gameType":"<spiel>","score":…,"total":…,"day":"JJJJ-MM-TT[::europe]"`.
   Nur Einträge mit dem heutigen Berlin-Datum zählen.

   Mapping auf den Formularwert (`wert` in der Antwort):

   | Spiel          | wert                                        |
   |----------------|---------------------------------------------|
   | georankle      | `score` (Welt bzw. `day`-Suffix `::europe`) |
   | geoconnections | Fehler = 4 − `data.lives`                   |
   | geodecide      | `score` = Level (0–15)                      |
   | geopaint       | `score` (Dezimalzahl, z. B. 35.89)          |
   | geodle         | `data.guesses` = Versuche                   |

   **Flagle** (flagle-game.com) hat keinen Account: Das Skript läuft auch auf
   der Spiel-Domain und sichert `localStorage["flagle-state"]` per
   `GM_setValue` in den geteilten Tampermonkey-Speicher – ereignisgesteuert
   (Seiten-Load, Tab versteckt/geschlossen, Fensterfokus weg), kein Polling;
   die Formular-Seite liest ihn mit `GM_getValue` (funktioniert daher nur im
   Browser, in dem gespielt wurde).
   Tag-Validierung über `dayNumber` (Anker: 2026-07-19 = Tag 1587).
   Mapping: gewonnen → Versuche; 6 Versuche verloren → 7; 5 Versuche
   verloren → leer (privater 6. Versuch nicht erkennbar).

   **Mapster** (mapster.teuteuf.fr, Teuteuf-Login): Der Account-Sync befüllt
   `localStorage["mapster-drawings"]` (`{ "JJJJ-MM-TT": {score, hintsUsed} }`)
   beim Seitenladen – auch auf Rechnern, auf denen nicht gespielt wurde
   (dort reicht ein Seitenbesuch). Schnappschuss ereignisgesteuert wie bei
   Flagle plus ein einmaliger Nachzügler nach 4 s für die asynchrone
   Sync-Antwort. Wert = `score` (0–1000) des heutigen Berlin-Datums.
   (Direkter API-Abruf wäre `auth.teuteuf.fr/api/getdata`, ist aber nicht
   per einfachem GET zugänglich – 404, vermutlich POST + Token.)

   **Flagpie** (flagpie.net): Schnappschuss-Brücke.
   `flagpieGameState_<JJJJMMTT>` mit `isOver:true`; Wert = `guessesUsed`
   bei Sieg, **6** bei Niederlage (5 echte Versuche, der 6. Formularwert
   ist der Verloren-Fall). Supabase-Backend existiert, aber der
   Access-Token läuft stündlich ab → localStorage ist robuster.

   **Travle** (travle.earth): Schnappschuss-Brücke. Heutiges Spiel =
   `travle-past-games`-Eintrag mit `gameId == puzzleIx` aus
   `travle-game-state` (Archiv-Modus wird ignoriert; Anker: puzzleIx 1313 =
   2026-07-19). Wert: `perfect` (Länder in richtiger Reihenfolge) → **-1**,
   sonst `guesses − minGuesses`; verloren/unfertig → leer.

   **Geozee** (geozee.earth, kein Sync): Schnappschuss-Brücke.
   `geozee:game:<JJJJ-MM-TT>` mit `finished:true`; Wert = `firstScore`
   (falls vorhanden – der erste Versuch zählt, Replays egal), sonst `total`.

   **Globle** (globle-game.com, Trainwreck-Labs-Login): Die synchronisierte
   Statistik ist über die **öffentliche** API `/account?email=…` abrufbar –
   ohne Cookie, funktioniert auf jedem Rechner. Die Login-E-Mail merkt sich
   das Skript bei jedem Globle-Besuch aus `localStorage["user"]`
   (`GM_setValue("globle-email")`); Fallback ist die Google-Konto-Mail, die
   das Formular im Anfrage-Event mitschickt. Mapping: `stats.lastWin` am
   heutigen Berlin-Tag → letzter Eintrag von `stats.usedGuesses` = Versuche;
   sonst leer (heute noch nicht gelöst).

3. Handshake: Das Userscript bestätigt den Empfang sofort (`…-empfangen`
   bzw. `{geoscores:"empfangen"}`), noch vor dem Datenabruf – so
   unterscheidet das Formular „Skript läuft hier nicht" (Warnung nach 2 s)
   von „Abruf hängt" (Fehler nach 12 s). Beide Seiten loggen mit Präfix
   `[Geo-Autofill]` bzw. `[Autofill]` in die Konsole.

   **Zwei Transportkanäle** (seit v0.9.0): DOM-Events funktionieren nur,
   wenn Tampermonkey den verschachtelten Apps-Script-Sandbox-iframe des
   Formulars injiziert – auf /exec passiert das nicht zuverlässig (Skript
   landet nur in Nachbar-Frames). Deshalb schickt das Formular die Anfrage
   zusätzlich per `window.top.postMessage({geoscores:"anfrage", email}, "*")`
   an script.google.com (immer injizierbar); die dortige Instanz antwortet
   über `ev.source.postMessage` direkt in den Formular-Frame (targetOrigin
   `*`, weil der Sandbox-Frame eine opake Origin hat). Doppelte Antworten
   fängt der Timer-Guard im Formular ab.
4. Antwort per Event `geoscores-autofill-antwort`, detail = JSON-String:
   `{ ok, tag, welt: {wert,score,total}|null, europa, geoconnections,
   geodecide, geopaint, geodle, warnung? }` (bzw. `{ ok:false, fehler }`,
   wenn alle Abrufe scheitern).

## Installation

`geo-autofill.user.js` in Tampermonkey/Violentmonkey importieren
(Greasyfork-Veröffentlichung ausstehend).
