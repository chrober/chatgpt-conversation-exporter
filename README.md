# ChatGPT Conversation Exporter

Ein eigenständiges **Greasemonkey-/Tampermonkey-Userscript** zum lokalen JSON-Export **einer einzelnen, aktuell geöffneten Original-ChatGPT-Unterhaltung**. Kein Gesamtexport des Kontos und kein automatischer Export bei jedem Seitenaufruf.

> **Status: Entwicklungsfassung 0.1.4 auf Feature-Branch.** Die zugrundeliegende Browser-Konsolen-Version wurde praktisch bestätigt. Die Tampermonkey-Version 0.1.1 wurde unter Firefox vom Anwender erfolgreich getestet. Die neuen 0.1.4-Änderungen (Position, englische Oberfläche und Profiling) benötigen noch einen abschließenden Browsertest.

## Installation und Bedienung

1. Für Firefox **Tampermonkey** (oder Greasemonkey 4.11+) installieren.
2. Die Datei [`userscripts/chatgpt-conversation-export.user.js`](userscripts/chatgpt-conversation-export.user.js) aus diesem Branch installieren. [Direktlink zur Raw-Datei](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/refs/heads/feat/greasemonkey-single-conversation-export/userscripts/chatgpt-conversation-export.user.js). **Version 0.1.4:** Eine bereits installierte Version 0.1.0/0.1.1 aktualisieren oder ersetzen, nicht zusätzlich als zweites aktives Script installieren.
3. Auf `https://chatgpt.com` anmelden und **einen Original-Chat** öffnen: `/c/<uuid>` oder `/g/.../c/<uuid>`. Nach Installation/Update den Chat-Tab **neu laden**, um das neue Script auszuführen.
4. Unten rechts auf der ChatGPT-Seite **„Export chat as JSON“** klicken. Alternativ den Befehl **„Export current chat as JSON“** im Userscript-Manager-Menü wählen, falls dieser angeboten wird. Der kleine Pfeil neben dem installierten Script in Tampermonkey öffnet **nur dessen Verwaltungsmenü**, nicht den Export.
5. Das Statusfenster oberhalb des Export-Buttons zeigt **„API pages“** und **„message records“** an. **Cancel** unterbricht den Abruf, **Export chat as JSON** setzt ihn im selben Tab fort. Nach mindestens einer Antwort steht **„Save performance report“** für einen separaten, optionalen Download bereit.
6. Nach bestätigtem Paginierungsende die Datei `chatgpt-conversation-<uuid>.json` im Browser-Downloadverzeichnis kontrollieren.

Das Repository ist inzwischen **öffentlich**. Die automatische Aktualisierung über `@downloadURL`/`@updateURL` ist bis zur ersten stabilen Version noch nicht konfiguriert; aktualisiere die Entwicklungsfassung bei Bedarf über den Raw-Link.

Ausführliche Hinweise: [Installation / manueller Smoke-Test](docs/installation-and-validation.md).

## Eigenschaften

- Tampermonkey-/Greasemonkey-Menüeintrag **und** sichtbarer Export-Button **unten rechts**, mit Fortschrittsfenster direkt darüber, ohne automatischen Export
- Automatische Ermittlung der aktuellen Chat-URL im **Moment des Klicks**
- Authentifizierter Abruf über die bestehende ChatGPT-Sitzung
- Cursor-Paginierung mit `num_turns=1`, `include_has_versions=true`, `before=start_cursor`
- Retry bei HTTP 429/500/502/503/504, Abbruch, Wiederaufnahme ohne erneutes Laden bereits validierter Seiten
- Verhinderung von Cursor-Schleifen; Validierung aller Seiten, Deduplizierung und Audit im JSON
- Englische Statusmeldungen mit **API pages** (= paginierte HTTP-Antworten, keine Browserseiten) und **message records** (= technische Nachrichtendatensätze)
- Optionaler **„Save performance report“**-Download ohne Chat-Inhalte/IDs: HTTP-Status, Retries, Datensätze und Zeiten pro API-Seite, JSON-Parsing und Serialisierung
- **Cancel** ist nur während eines laufenden Exports aktiv; danach **disabled und sichtbar grau**. Die Änderung ist durch einen UI-Test abgesichert.
- Keine Laufzeitbibliotheken, keine externen `@require`-Skripte

## Entwicklung

Voraussetzung: Node.js 22 oder höher. Keine zusätzlichen npm-Abhängigkeiten.

```bash
npm run build
npm run check
```

Die **Quellen** liegen in `src/exporter-core.js` (testbare API-/Paginierungslogik), `src/profiling.js` (inhaltfreies Performance-Profiling) und `src/userscript-entry.js` (Userscript-Manager-Menü, Export-Button, Statusfenster, Download). `scripts/build-userscript.js` generiert daraus deterministisch `userscripts/chatgpt-conversation-export.user.js`. Bitte **nicht nur die generierte Datei** bearbeiten. Die CI überprüft Syntax, Bundle-Gleichheit und Node-basierte Tests und vermeidet Push+PR-Doppelruns: Push nur auf `main`, PR auf Feature-Branches. Reine Dokumentationsänderungen lösen keine CI aus.

Architektur und Grenzen: [Technische Dokumentation](docs/architecture-and-limitations.md). Der erste anonymisierte [Performance-Baseline-Bericht](docs/performance-baseline-2026-11-01.md) beschreibt Engpässe und kontrollierte Optimierungsexperimente.

## Herkunft und Evidenz

Die Logik basiert auf einem mehrfach erfolgreich getesteten JavaScript-Konsolenexport aus dem Lyrion-Projekt. Am 31. Oktober 2026 lieferte die URL-basierte V2-Version bei einem langen Original-Chat **64 Seiten, 4.970 eindeutige Datensätze, keine Duplikate und 55,35 MiB**; der End-Cursor meldete `has_previous_page=false`. Die automatische URL-Ermittlung über `window.location.origin + window.location.pathname` wurde ebenfalls bestätigt. **Diese Zahlen gelten für den ursprünglichen Konsolenexport**, nicht für andere Unterhaltungen. Der Tampermonkey-Exporter wurde inzwischen separat im Firefox erfolgreich getestet. Private Chat-IDs, Prompts und JSON-Exporte werden nicht ins Repository übernommen.

## Sicherheit und Einschränkungen

Die ChatGPT-Endpunkte sind intern und undokumentiert; Änderungen können das Userscript jederzeit unbrauchbar machen. Es funktioniert nur für **berechtigt zugängliche Original-Chats**, nicht für `/share/...`-Links. Der JSON-Export enthält unter Umständen interne Tool-Datensätze, personenbezogene Informationen, Pfade, Referenzen oder vertrauliche Inhalte. Anhänge werden **nicht separat heruntergeladen**. `pagination_verified=true` bestätigt nur das von der API gemeldete Ende der Seitenfolge, nicht sämtliche Versionen oder Branches.

Das Userscript ruft nur relative Endpunkte von `chatgpt.com` auf und lädt die JSON lokal herunter; es sendet keine Chat-Daten an GitHub oder andere Dienste. Der Sitzungstoken wird für authentifizierte Anfragen verwendet und nicht in die JSON geschrieben. **Exportdateien keinesfalls committen oder ungeprüft weitergeben.** Der separate Performance-Bericht wird nur nach Klick auf **Save performance report** gespeichert und enthält keine Chat-Inhalte, Conversation-IDs oder Cursor. Er enthält jedoch Zeitstempel und Nutzungs-/Leistungsdaten; auch diesen Bericht vor öffentlicher Weitergabe prüfen.

Für den offiziell unterstützten Gesamtexport: ChatGPT → Einstellungen → Datenkontrollen → Daten exportieren.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
