// ==UserScript==
// @name         Geo Scores Autofill
// @namespace    jago/geo-autofill
// @version      0.11.0
// @description  Brücke fürs Geo-Scores-Formular: holt auf Klick des Zauberstabs die heutigen Ergebnisse aus dem eingeloggten geotrivia.com-Account (GeoRankle Welt + Europa, Geoconnections, GeoDecide, GeoPaint, Geodle), die Globle-Statistik (öffentliche Account-API) sowie die lokalen Spielstände von Flagle, Flagpie, Mapster, Travle und Geozee und reicht sie ans Formular durch. Läuft im Apps-Script-Sandbox-iframe (googleusercontent.com) und als Spielstand-Sammler auf den Spiel-Domains.
// @author       jago/claude
// @license      MIT
// @homepageURL  https://greasyfork.org/de/scripts/587742-geo-scores-autofill
// @match        https://script.google.com/*
// @match        https://*.googleusercontent.com/*
// @match        https://flagle-game.com/*
// @match        https://flagpie.net/*
// @match        https://globle-game.com/*
// @match        https://mapster.teuteuf.fr/*
// @match        https://travle.earth/*
// @match        https://geozee.earth/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      geotrivia.com
// @connect      globle-game.com
// ==/UserScript==

(function () {
  'use strict';

  // Kommunikation mit dem Formular über DOM-Events. Das Formular schickt die
  // Anfrage, wir antworten mit einem JSON-String im detail – ein Objekt käme
  // in Firefox wegen der Sandbox-Grenze nicht lesbar auf der Seite an.
  const ANFRAGE = 'geoscores-autofill-anfrage';
  const ANTWORT = 'geoscores-autofill-antwort';
  // Sofort-Bestätigung VOR dem Datenabruf: damit kann das Formular
  // unterscheiden zwischen "Skript läuft hier gar nicht" und "Abruf dauert/hängt"
  const EMPFANG = 'geoscores-autofill-empfangen';

  console.log('[Geo-Autofill v' + GM_info.script.version + '] aktiv auf ' + location.hostname + ' (' + location.href + ')');

  // Jede geotrivia-Spielseite bettet nur ihr eigenes serverGameResult ein,
  // deshalb ein Abruf pro Spiel (laufen parallel).
  const SPIELSEITEN = ['georankle', 'geoconnections', 'geodecide', 'geopaint', 'geodle'];

  function heuteBerlin() {
    // en-CA liefert das ISO-Format JJJJ-MM-TT
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  }

  // ---- Flagle (flagle-game.com): kein Account, kein Server-Ergebnis ----
  // Der Spielstand existiert nur im localStorage der Spiel-Domain. Deshalb
  // läuft dieses Skript auch dort und legt einen Schnappschuss in den
  // Tampermonkey-Speicher (GM_setValue) – der ist pro Userscript über alle
  // Domains geteilt, die Formular-Seite liest ihn mit GM_getValue.
  // Flagle-Autofill funktioniert daher nur im Browser, in dem gespielt wurde.
  //
  // Kein Polling: Ein On-Demand-Abruf beim Autofill-Klick ist unmöglich,
  // wenn kein Flagle-Tab (mehr) offen ist. Stattdessen wird genau dann
  // gesichert, wenn es etwas zu sichern geben kann: beim Laden der Seite und
  // beim Verlassen (Tab versteckt/geschlossen, Fenster verliert den Fokus –
  // spätestens der Wechsel zum Formular löst also einen Schnappschuss aus).
  if (location.hostname === 'flagle-game.com') {
    let letzterStand = null;
    const schnappschuss = function (anlass) {
      try {
        const erwartet = flagleDayNumber(heuteBerlin());
        // Das win-Flag im State ist unzuverlässig: Bei deaktivierten
        // Animationen setzt das Spiel es nie (der localStorage-Write hängt
        // im setTimeout des Animations-Zweigs – Bug im Spiel). Die
        // Statistik-Buckets (flagle-statistics.guesses: 1–6, X) werden
        // dagegen bei Spielende immer synchron hochgezählt und sonst nie
        // angefasst. Solange der State noch vom Vortag ist, ist die
        // Statistik also der Stand VOR dem heutigen Spiel – als Baseline
        // gesichert erlaubt sie der Auswertung den Tages-Diff.
        let buckets = null;
        try {
          const stats = JSON.parse(localStorage.getItem('flagle-statistics'));
          if (stats && stats.guesses) buckets = stats.guesses;
        } catch (e) { /* defekte Statistik – dann eben ohne Diff */ }
        const raw = localStorage.getItem('flagle-state');
        if (buckets && (!raw || JSON.parse(raw).dayNumber !== erwartet)) {
          GM_setValue('flagle-stats-baseline', { fuerTag: erwartet, buckets: buckets, stand: Date.now() });
        }
        if (!raw) {
          console.warn('[Flagle] (' + anlass + ') kein localStorage-Schlüssel "flagle-state" – wurde heute schon ein Spiel gestartet? Vorhandene flagle-Schlüssel:',
            Object.keys(localStorage).filter(function (k) { return /flagle/i.test(k); }));
          return;
        }
        const kombi = raw + '\n' + JSON.stringify(buckets);
        if (kombi === letzterStand) return; // unverändert seit letztem Sichern
        letzterStand = kombi;
        const st = JSON.parse(raw);
        const eintrag = {
          dayNumber: st.dayNumber,
          versuche: (st.guesses || []).length,
          win: !!st.win,
          hardMode: !!st.hardMode,
          buckets: buckets,
          stand: Date.now(),
        };
        GM_setValue('flagle', eintrag);
        console.log('[Flagle] (' + anlass + ') Schnappschuss gesichert:', eintrag,
          '(erwarteter dayNumber für heute Berlin:', erwartet + ')');
        if (eintrag.dayNumber == null) {
          console.warn('[Flagle] Achtung: State enthält keinen dayNumber – Format geändert? Roh-State-Schlüssel:', Object.keys(st));
        }
      } catch (e) {
        console.error('[Flagle] (' + anlass + ') Schnappschuss fehlgeschlagen (defekter State?):', e);
      }
    };
    schnappschuss('Seitenladen');
    window.addEventListener('blur', function () { schnappschuss('blur'); });
    window.addEventListener('pagehide', function () { schnappschuss('pagehide'); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') schnappschuss('versteckt');
    });
    return; // auf der Spiel-Domain gibt es sonst nichts zu tun
  }

  // ---- Flagpie (flagpie.net): Schnappschuss ----
  // flagpieGameState_<JJJJMMTT> = {guessesUsed, isOver, isWon, ...}.
  // (Es gäbe ein Supabase-Backend, aber dessen Access-Token läuft stündlich
  // ab – der Schnappschuss ist robuster.)
  if (location.hostname === 'flagpie.net') {
    const sichern = function () {
      try {
        const heute = heuteBerlin();
        const spiel = JSON.parse(localStorage.getItem('flagpieGameState_' + heute.replace(/-/g, '')) || 'null');
        if (spiel && spiel.isOver) {
          GM_setValue('flagpie', {
            tag: heute,
            versuche: spiel.guessesUsed,
            gewonnen: !!spiel.isWon,
            stand: Date.now(),
          });
        }
      } catch (e) { /* defekter State – nächstes Ereignis versucht es erneut */ }
    };
    sichern();
    window.addEventListener('blur', sichern);
    window.addEventListener('pagehide', sichern);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') sichern();
    });
    return;
  }

  // Flagpie-Konvention: gewonnen → Versuche (1–5); verloren → 6
  // (5 echte Versuche, der 6. Formularwert ist der Verloren-Fall)
  function flagpieErgebnis(heute) {
    const s = GM_getValue('flagpie', null);
    if (!s || s.tag !== heute) return null;
    return { wert: s.gewonnen ? s.versuche : 6 };
  }

  // ---- Travle (travle.earth): Schnappschuss wie Flagle/Mapster ----
  // travle-past-games enthält pro Spiel {gameId, guesses, minGuesses, won,
  // numHints, perfect}; das heutige Spiel ist der Eintrag mit gameId ==
  // puzzleIx aus travle-game-state (nur wenn kein Archiv-Modus).
  if (location.hostname === 'travle.earth') {
    const sichern = function () {
      try {
        const state = JSON.parse(localStorage.getItem('travle-game-state') || 'null');
        if (!state || state.isArchiveMode) return;
        const vergangene = JSON.parse(localStorage.getItem('travle-past-games') || 'null');
        let spiel = null;
        if (vergangene && Array.isArray(vergangene.games)) {
          for (const g of vergangene.games) {
            if (g.gameId === state.puzzleIx) spiel = g;
          }
        }
        GM_setValue('travle', {
          puzzleIx: state.puzzleIx,
          gameProgress: state.gameProgress,
          spiel: spiel,
          stand: Date.now(),
        });
      } catch (e) { /* defekter State – nächstes Ereignis versucht es erneut */ }
    };
    sichern();
    setTimeout(sichern, 4000); // Nachzügler für asynchron eintreffende Daten
    window.addEventListener('blur', sichern);
    window.addEventListener('pagehide', sichern);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') sichern();
    });
    return;
  }

  // ---- Geozee (geozee.earth): Schnappschuss, kein Sync ----
  // geozee:game:<JJJJ-MM-TT> = {date, total, firstScore?, bestScore?,
  // replayCount?, finished, ...}. Konvention: der erste Versuch zählt –
  // firstScore, falls die Seite Replays kennt; ältere Einträge haben nur total.
  if (location.hostname === 'geozee.earth') {
    const sichern = function () {
      try {
        const heute = heuteBerlin();
        const spiel = JSON.parse(localStorage.getItem('geozee:game:' + heute) || 'null');
        if (spiel && spiel.finished) {
          const score = (typeof spiel.firstScore === 'number') ? spiel.firstScore : spiel.total;
          // Lieber nichts sichern als einen Platzhalter: fehlt beides,
          // hat die Seite ihr Format geändert – das soll auffallen.
          if (typeof score === 'number') {
            GM_setValue('geozee', { tag: heute, score: score, stand: Date.now() });
          } else {
            console.warn('[Geozee] kein Score im gespeicherten Spiel gefunden', spiel);
          }
        }
      } catch (e) { /* defekter State – nächstes Ereignis versucht es erneut */ }
    };
    sichern();
    setTimeout(sichern, 4000);
    window.addEventListener('blur', sichern);
    window.addEventListener('pagehide', sichern);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') sichern();
    });
    return;
  }

  // Travle zählt Rätsel durch: 2026-07-19 = puzzleIx 1313 (Anker, per Dump belegt)
  function travlePuzzleIx(datumISO) {
    const teile = datumISO.split('-').map(Number);
    return 1313 + Math.round((Date.UTC(teile[0], teile[1] - 1, teile[2]) - Date.UTC(2026, 6, 19)) / 86400000);
  }

  // Travle-Konvention der Runde: "Perfect" → -1, sonst die Zusatz-Rätze
  // (guesses − minGuesses, also +0, +1, …); verloren/unfertig → leer.
  //
  // ACHTUNG, Stolperfalle im Spiel-State: das Feld `perfect` allein bedeutet
  // NICHT "Perfect". Travle setzt es beim Spielstart auf true und nur dann auf
  // false, wenn ein Rateversuch die Kette nicht berührt ("Country not
  // connected"). Ein sauber geratenes Spiel mit Umwegen behält also
  // perfect:true. Das Spiel selbst zeigt "Perfect" erst bei
  //   won && guesses === minGuesses && perfect
  // (identisch in der Verteilungs-Grafik: Balken 0 = perfect && extra === 0,
  // Balken 1 = "+0"). Genau diese Und-Verknüpfung wird hier gespiegelt –
  // andernfalls landet -1 im Formular, obwohl es nur ein +2 war.
  function travleErgebnis(heute) {
    const s = GM_getValue('travle', null);
    if (!s) {
      console.warn('[Travle] null: kein Schnappschuss im Tampermonkey-Speicher. '
        + 'Wurde Travle in DIESEM Browser auf travle.earth gespielt?');
      return null;
    }
    if (s.puzzleIx !== travlePuzzleIx(heute)) {
      console.warn('[Travle] null: Schnappschuss gehört zu einem anderen Rätsel. '
        + 'gespeichert puzzleIx=' + s.puzzleIx + ', erwartet (heute Berlin ' + heute + ')='
        + travlePuzzleIx(heute) + '.', s);
      return null;
    }
    const g = s.spiel;
    if (!g || !g.won) return null; // verloren oder noch nicht fertig → Feld bleibt leer
    if (typeof g.guesses !== 'number' || typeof g.minGuesses !== 'number') {
      console.warn('[Travle] null: guesses/minGuesses fehlen oder sind keine Zahlen – '
        + 'hat travle.earth das Format von travle-past-games geändert?', g);
      return null;
    }
    const zusatz = Math.max(g.guesses - g.minGuesses, 0);
    // -1 nur mit ausdrücklichem Beleg: perfect muss echtes true sein
    // (fehlendes Feld ⇒ kein Beleg ⇒ regulär +0), Umwege schließen es aus.
    const perfekt = g.perfect === true && zusatz === 0;
    return { wert: perfekt ? -1 : zusatz, guesses: g.guesses, minGuesses: g.minGuesses, perfect: g.perfect };
  }

  function geozeeErgebnis(heute) {
    const s = GM_getValue('geozee', null);
    if (!s || s.tag !== heute) return null;
    return { wert: s.score };
  }

  // ---- Mapster (mapster.teuteuf.fr): Teuteuf-Sync in den localStorage ----
  // mapster-drawings = { "JJJJ-MM-TT": { score, hintsUsed }, ... }. Der
  // Teuteuf-Account-Sync befüllt den localStorage beim Laden der Seite, auch
  // auf Rechnern, auf denen nicht gespielt wurde – dort genügt also ein
  // Seitenbesuch. Gesichert wird ereignisgesteuert wie bei Flagle; der eine
  // verzögerte Nachzügler fängt die asynchron eintreffende Sync-Antwort ab.
  if (location.hostname === 'mapster.teuteuf.fr') {
    const sichern = function () {
      try {
        const alle = JSON.parse(localStorage.getItem('mapster-drawings') || 'null');
        const heute = heuteBerlin();
        const eintrag = alle && alle[heute];
        if (eintrag && typeof eintrag.score === 'number') {
          GM_setValue('mapster', {
            tag: heute,
            score: eintrag.score,
            hintsUsed: eintrag.hintsUsed || 0,
            stand: Date.now(),
          });
        }
      } catch (e) { /* defekter Eintrag – nächstes Ereignis versucht es erneut */ }
    };
    sichern();
    setTimeout(sichern, 4000); // einmalig: Sync-Antwort kommt erst nach dem Laden
    window.addEventListener('blur', sichern);
    window.addEventListener('pagehide', sichern);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') sichern();
    });
    return;
  }

  // Mapster: gesicherten Schnappschuss nur verwenden, wenn er von heute ist
  function mapsterErgebnis(heute) {
    const s = GM_getValue('mapster', null);
    if (!s || s.tag !== heute) return null;
    return { wert: s.score };
  }

  // ---- Globle (globle-game.com): öffentliche Account-API ----
  // Die synchronisierte Statistik ist unter /account?email=… OHNE Cookie
  // abrufbar; gebraucht wird nur die Login-E-Mail. Die merken wir uns bei
  // jedem Globle-Besuch aus dem localStorage – als Fallback schickt das
  // Formular die Google-Konto-Mail des Spielers mit.
  if (location.hostname === 'globle-game.com') {
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      if (user && user.email) GM_setValue('globle-email', user.email);
    } catch (e) { /* kein Login o. defekter Eintrag – Fallback greift */ }
    return;
  }

  // Globle: lastWin am heutigen Berlin-Tag → letzter usedGuesses-Eintrag =
  // heutige Versuche; sonst (heute noch nicht gelöst) kein Eintrag.
  // Löst immer auf (nie reject), Fehler kommen als res.fehler zurück.
  function globleErgebnis(heute, formularEmail) {
    return new Promise(function (resolve) {
      const email = GM_getValue('globle-email', null) || formularEmail;
      if (!email) {
        resolve({ eintrag: null, fehler: 'Globle: keine E-Mail bekannt (einmal globle-game.com besuchen)' });
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://globle-game.com/account?email=' + encodeURIComponent(email),
        timeout: 15000,
        onload: function (resp) {
          try {
            if (resp.status !== 200) {
              resolve({ eintrag: null, fehler: 'Globle: HTTP ' + resp.status });
              return;
            }
            const stats = (JSON.parse(resp.responseText) || {}).stats;
            if (!stats || !stats.lastWin || !Array.isArray(stats.usedGuesses) || stats.usedGuesses.length === 0) {
              resolve({ eintrag: null });
              return;
            }
            const siegTag = new Date(stats.lastWin).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
            if (siegTag !== heute) {
              resolve({ eintrag: null }); // heute (noch) nicht gelöst
              return;
            }
            resolve({ eintrag: { wert: stats.usedGuesses[stats.usedGuesses.length - 1] } });
          } catch (e) {
            resolve({ eintrag: null, fehler: 'Globle: ' + String(e) });
          }
        },
        onerror: function () { resolve({ eintrag: null, fehler: 'Globle: Netzwerkfehler' }); },
        ontimeout: function () { resolve({ eintrag: null, fehler: 'Globle: Zeitüberschreitung' }); },
      });
    });
  }

  // Flagle zählt Tage durch: 2026-07-19 = Tag 1587 (Anker, per Dump belegt)
  function flagleDayNumber(datumISO) {
    const teile = datumISO.split('-').map(Number);
    const anker = Date.UTC(2026, 6, 19);
    return 1587 + Math.round((Date.UTC(teile[0], teile[1] - 1, teile[2]) - anker) / 86400000);
  }

  // Mapping auf die Punkte-Konvention der Runde:
  //   gelöst           → Versuche (1–6)
  //   6 Versuche, verloren → 7
  //   5 Versuche, verloren → nicht entscheidbar (der 6. Versuch wird ggf. im
  //     privaten Fenster gespielt und landet nicht in diesem localStorage)
  function flagleErgebnis(heute) {
    const s = GM_getValue('flagle', null);
    const erwartet = flagleDayNumber(heute);
    if (!s) {
      console.warn('[Flagle] null: kein Schnappschuss im Tampermonkey-Speicher. '
        + 'Wurde Flagle in DIESEM Browser (mit diesem Userscript) auf flagle-game.com gespielt? '
        + 'Andere Domain (www.-Subdomain, flagle.io o. Ä.) würde vom @match nicht erfasst.');
      return null;
    }
    if (s.dayNumber !== erwartet) {
      const alterMin = s.stand ? Math.round((Date.now() - s.stand) / 60000) : null;
      console.warn('[Flagle] null: Schnappschuss ist für einen anderen Tag. '
        + 'gespeicherter dayNumber=' + s.dayNumber + ', erwartet (heute Berlin ' + heute + ')=' + erwartet + '. '
        + (alterMin != null ? 'Schnappschuss ist ' + alterMin + ' Min alt. ' : '')
        + 'Ursache: entweder nicht heute gespielt, oder Tagesgrenze/Zeitzone weicht ab.', s);
      return null;
    }
    if (s.win && s.versuche >= 1) return { wert: s.versuche, versuche: s.versuche, win: true };
    if (!s.win && s.versuche >= 6) return { wert: 7, versuche: s.versuche, win: false };
    const diff = flagleStatistikDiff(s, erwartet);
    if (diff) {
      console.log('[Flagle] win-Flag fehlt (Animationen im Spiel deaktiviert?), '
        + 'aber der Statistik-Diff belegt: Sieg mit ' + diff.versuche + ' Versuchen.');
      return diff;
    }
    console.warn('[Flagle] null: Schnappschuss ist von heute, aber nicht eindeutig auswertbar. '
      + 'win=' + s.win + ', versuche=' + s.versuche + '. '
      + 'Auch der Statistik-Diff konnte nicht entscheiden (Baseline fehlt/veraltet, '
      + 'Spiel läuft noch, oder Diff unplausibel). '
      + 'Bekannter Grenzfall: verloren mit <6 sichtbaren Versuchen (6. Versuch evtl. im privaten Fenster gespielt).', s);
    return null;
  }

  // Rückfallebene für das unzuverlässige win-Flag (bei deaktivierten
  // Animationen setzt das Spiel es nie): Tages-Diff der Statistik-Buckets
  // gegen die Baseline, die der Schnappschuss auf der Spiel-Domain vor dem
  // ersten Guess des Tages gesichert hat. Nur ein exakt plausibles Ergebnis
  // zählt – genau ein Bucket um genau 1 gewachsen und passend zur Guess-Zahl
  // im State; alles andere (Uhr verstellt, Storage zurückgespielt) → null.
  // Kein Diff heißt: Spiel läuft noch (Denkpause zählt nicht als Sieg).
  function flagleStatistikDiff(s, erwartet) {
    const basis = GM_getValue('flagle-stats-baseline', null);
    if (!basis || basis.fuerTag !== erwartet || !basis.buckets || !s.buckets) return null;
    let gewachsen = null;
    for (const k of ['1', '2', '3', '4', '5', '6', 'X']) {
      const d = (s.buckets[k] || 0) - (basis.buckets[k] || 0);
      if (d === 0) continue;
      if (d !== 1 || gewachsen !== null) return null;
      gewachsen = k;
    }
    if (gewachsen === null) return null;
    // 'X' (verloren) hätte 6 Guesses im State und wäre oben schon als 7
    // gewertet worden – hier wäre es ein Widerspruch, ebenso eine Bucket-
    // Nummer, die nicht zur Guess-Zahl passt.
    if (Number(gewachsen) !== s.versuche) return null;
    return { wert: s.versuche, versuche: s.versuche, win: true };
  }

  // Next.js liefert die Seitendaten in mehreren self.__next_f.push([1,"..."])-
  // Häppchen; eine Häppchen-Grenze kann mitten in einem Wert liegen. Deshalb
  // erst alles zu einem durchgehenden (escapten) JSON-String zusammensetzen –
  // gleiche Technik wie im Apps-Script-Backend (geo_webform.js).
  function streamAusHtml(html) {
    const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
    let stream = '';
    let m;
    while ((m = re.exec(html)) !== null) stream += m[1];
    return stream || html;
  }

  // Im Stream steht das synchronisierte serverGameResult des eingeloggten
  // Accounts, z. B.: gameType\":\"georankle\",\"score\":447,\"total\":642,
  // \"day\":\"2026-07-19\",\"data\":{...}. Die \\?"-Muster matchen escaped
  // UND unescapt (Fallback, falls die Seite das Format ändert).
  //
  // Wertermittlung fürs Formular ("wert"):
  //   georankle      score direkt (Europa-Modus: day = "…::europe")
  //   geodecide      score = erreichtes Level (0–15)
  //   geopaint       score = Punkte, Dezimalzahl (z. B. 35.89)
  //   geoconnections Fehler = 4 − data.lives (score wäre: gelöste Gruppen)
  //   geodle         data.guesses = Versuche (score wäre: gewonnen 0/1)
  // Nur Einträge mit dem heutigen Berlin-Datum zählen.
  function ergebnisseSammeln(html, heute, ziel) {
    const stream = streamAusHtml(html);
    const re = /gameType\\?":\\?"(\w+)\\?",\\?"score\\?":([\d.]+),\\?"total\\?":([\d.]+),\\?"day\\?":\\?"(\d{4}-\d{2}-\d{2}(?:::europe)?)\\?"/g;
    let m;
    while ((m = re.exec(stream)) !== null) {
      const typ = m[1];
      const tag = m[4];
      if (tag !== heute && tag !== heute + '::europe') continue;
      const score = parseFloat(m[2]);
      const total = parseFloat(m[3]);
      // data-Block folgt direkt auf den Treffer – Fenster reicht für lives/guesses
      const rest = stream.slice(m.index, m.index + 800);
      if (typ === 'georankle') {
        ziel[tag === heute + '::europe' ? 'europa' : 'welt'] = { wert: score, score: score, total: total };
      } else if (typ === 'geodecide') {
        ziel.geodecide = { wert: score, score: score, total: total };
      } else if (typ === 'geopaint') {
        ziel.geopaint = { wert: score, score: score, total: total };
      } else if (typ === 'geoconnections') {
        const lives = /lives\\?":(\d+)/.exec(rest);
        if (lives) ziel.geoconnections = { wert: 4 - parseInt(lives[1], 10), score: score, total: total };
      } else if (typ === 'geodle') {
        const guesses = /guesses\\?":(\d+)/.exec(rest);
        if (guesses) ziel.geodle = { wert: parseInt(guesses[1], 10), score: score, total: total };
      }
    }
  }

  // GM_xmlhttpRequest umgeht CORS und schickt die geotrivia-Cookies des
  // Browsers mit (Session + Zeitzone) – wir bekommen also genau die Seite,
  // die der eingeloggte Nutzer auch im Tab sehen würde.
  function holeSeite(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 15000,
        onload: function (resp) {
          if (resp.status === 200) resolve(resp.responseText);
          else reject(new Error('HTTP ' + resp.status + ' bei ' + url));
        },
        onerror: function () { reject(new Error('Netzwerkfehler bei ' + url)); },
        ontimeout: function () { reject(new Error('Zeitüberschreitung bei ' + url)); },
      });
    });
  }

  // Letztes Netz vor der Antwort ans Formular: dieselben Grenzen, die das
  // Formular in validate() prüft. Ein Wert, der hier durchfällt, ist kein
  // Ergebnis, sondern ein Symptom (Spielseite hat ihr Format geändert,
  // Rechenfehler, undefined in einer Rechnung → NaN). Er wird verworfen statt
  // eingetragen: ein leeres Feld sieht man, eine stille Falschzahl nicht.
  // min/max sind bewusst weit – sie sollen Unsinn abfangen, nicht schlechte
  // Ergebnisse. Kein Eintrag hier ⇒ keine Prüfung möglich ⇒ auffliegen lassen.
  const WERTEBEREICHE = {
    welt:           { min: 0 },
    europa:         { min: 0 },
    geoconnections: { min: 0, max: 4 },
    geodecide:      { min: 0, max: 15 },
    geopaint:       { min: 0, max: 50 },
    geodle:         { min: 1 },
    flagle:         { min: 1, max: 7 },
    flagpie:        { min: 1, max: 6 },
    globle:         { min: 1 },
    travle:         { min: -1 },
    mapster:        { min: 0, max: 1000 },
    geozee:         { min: 0, max: 900 },
  };

  function plausibilitaetPruefen(daten) {
    Object.keys(WERTEBEREICHE).forEach(function (key) {
      const eintrag = daten[key];
      if (!eintrag) return;
      const grenzen = WERTEBEREICHE[key];
      const w = eintrag.wert;
      let grund = null;
      if (typeof w !== 'number' || !isFinite(w)) grund = 'keine endliche Zahl';
      else if (grenzen.min !== undefined && w < grenzen.min) grund = 'kleiner als ' + grenzen.min;
      else if (grenzen.max !== undefined && w > grenzen.max) grund = 'größer als ' + grenzen.max;
      if (grund) {
        console.warn('[Geo-Autofill] ' + key + ' verworfen: Wert ' + JSON.stringify(w)
          + ' ist ' + grund + ' – Feld bleibt leer.', eintrag);
        daten[key] = null;
      }
    });
    return daten;
  }

  function antworten(obj) {
    console.log('[Geo-Autofill] Antwort ans Formular:', obj);
    window.dispatchEvent(new CustomEvent(ANTWORT, { detail: JSON.stringify(obj) }));
  }

  // Kernlogik, von beiden Kanälen genutzt: Ergebnisse einsammeln und
  // fertiges Antwort-Objekt liefern
  async function anfrageBearbeiten(formularEmail) {
    const heute = heuteBerlin();

    const daten = {
      ok: true, tag: heute,
      welt: null, europa: null, geoconnections: null,
      geodecide: null, geopaint: null, geodle: null,
      flagle: flagleErgebnis(heute),
      flagpie: flagpieErgebnis(heute),
      mapster: mapsterErgebnis(heute),
      travle: travleErgebnis(heute),
      geozee: geozeeErgebnis(heute),
      globle: null,
    };
    const fehler = [];

    const aufgaben = SPIELSEITEN.map(async function (spiel) {
      try {
        const html = await holeSeite('https://geotrivia.com/de/' + spiel);
        ergebnisseSammeln(html, heute, daten);
      } catch (e) {
        fehler.push(String(e.message || e));
      }
    });
    aufgaben.push(globleErgebnis(heute, formularEmail).then(function (res) {
      daten.globle = res.eintrag;
      if (res.fehler) fehler.push(res.fehler);
    }));
    await Promise.all(aufgaben);

    if (fehler.length >= aufgaben.length) {
      return { ok: false, fehler: fehler.join(' / ') };
    }
    if (fehler.length > 0) daten.warnung = fehler.join(' / ');
    return plausibilitaetPruefen(daten);
  }

  function emailAusDetail(detail) {
    try {
      return (JSON.parse(detail || 'null') || {}).email || null;
    } catch (e) {
      return null;
    }
  }

  // Kanal 1: DOM-Events – funktioniert nur, wenn diese Skript-Instanz im
  // selben Frame wie das Formular läuft (Tampermonkey injiziert die
  // verschachtelten Apps-Script-Sandbox-iframes nicht immer zuverlässig).
  window.addEventListener(ANFRAGE, async function (ev) {
    console.log('[Geo-Autofill] Event-Anfrage vom Formular empfangen, hole Ergebnisse …');
    window.dispatchEvent(new CustomEvent(EMPFANG, {
      detail: JSON.stringify({ version: GM_info.script.version, kanal: 'event' }),
    }));
    antworten(await anfrageBearbeiten(emailAusDetail(ev.detail)));
  });

  // Kanal 2: postMessage-Relay – das Formular schickt die Anfrage an
  // window.top (script.google.com, wird immer zuverlässig injiziert), diese
  // Instanz antwortet dem anfragenden Frame direkt über ev.source.
  // targetOrigin '*', weil der sandboxte Formular-Frame eine opake Origin hat.
  window.addEventListener('message', function (ev) {
    const d = ev.data;
    if (!d || d.geoscores !== 'anfrage' || !ev.source) return;
    console.log('[Geo-Autofill] postMessage-Anfrage empfangen (in ' + location.hostname + '), hole Ergebnisse …');
    ev.source.postMessage({ geoscores: 'empfangen', version: GM_info.script.version, kanal: 'postMessage' }, '*');
    anfrageBearbeiten(d.email || null).then(function (antwort) {
      console.log('[Geo-Autofill] postMessage-Antwort ans Formular:', antwort);
      ev.source.postMessage({ geoscores: 'antwort', daten: antwort }, '*');
    });
  });
})();
