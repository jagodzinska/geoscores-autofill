// ==UserScript==
// @name         Geo Scores Autofill
// @namespace    jago/geo-autofill
// @version      0.6.0
// @description  Brücke fürs Geo-Scores-Formular: holt auf Klick des Zauberstabs die heutigen Ergebnisse aus dem eingeloggten geotrivia.com-Account (GeoRankle Welt + Europa, Geoconnections, GeoDecide, GeoPaint, Geodle), die Globle-Statistik (öffentliche Account-API) sowie die lokalen Spielstände von Flagle und Mapster und reicht sie ans Formular durch. Läuft im Apps-Script-Sandbox-iframe (googleusercontent.com) und als Spielstand-Sammler auf den Spiel-Domains.
// @author       jago/claude
// @license      MIT
// @match        https://*.googleusercontent.com/*
// @match        https://flagle-game.com/*
// @match        https://globle-game.com/*
// @match        https://mapster.teuteuf.fr/*
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
    const schnappschuss = function () {
      try {
        const raw = localStorage.getItem('flagle-state');
        if (!raw || raw === letzterStand) return;
        letzterStand = raw;
        const st = JSON.parse(raw);
        GM_setValue('flagle', {
          dayNumber: st.dayNumber,
          versuche: (st.guesses || []).length,
          win: !!st.win,
          hardMode: !!st.hardMode,
          stand: Date.now(),
        });
      } catch (e) { /* defekter State – nächstes Ereignis versucht es erneut */ }
    };
    schnappschuss();
    window.addEventListener('blur', schnappschuss);
    window.addEventListener('pagehide', schnappschuss);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') schnappschuss();
    });
    return; // auf der Spiel-Domain gibt es sonst nichts zu tun
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
    if (!s || s.dayNumber !== flagleDayNumber(heute)) return null;
    if (s.win && s.versuche >= 1) return { wert: s.versuche, versuche: s.versuche, win: true };
    if (!s.win && s.versuche >= 6) return { wert: 7, versuche: s.versuche, win: false };
    return null;
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

  function antworten(obj) {
    window.dispatchEvent(new CustomEvent(ANTWORT, { detail: JSON.stringify(obj) }));
  }

  window.addEventListener(ANFRAGE, async function (ev) {
    const heute = heuteBerlin();
    let formularEmail = null;
    try {
      formularEmail = (JSON.parse(ev.detail || 'null') || {}).email || null;
    } catch (e) { /* alte Formular-Version ohne detail */ }

    const daten = {
      ok: true, tag: heute,
      welt: null, europa: null, geoconnections: null,
      geodecide: null, geopaint: null, geodle: null,
      flagle: flagleErgebnis(heute),
      mapster: mapsterErgebnis(heute),
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
      antworten({ ok: false, fehler: fehler.join(' / ') });
      return;
    }
    if (fehler.length > 0) daten.warnung = fehler.join(' / ');
    antworten(daten);
  });
})();
