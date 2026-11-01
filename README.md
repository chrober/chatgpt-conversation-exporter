# ChatGPT Conversation Exporter

Ein eigenständiges **Greasemonkey-Userscript** zum lokalen JSON-Export **einer einzelnen, aktuell geöffneten Original-ChatGPT-Unterhaltung**. Kein Gesamtexport des Kontos und kein automatischer Export bei jedem Seitenaufruf.

> **Status: Entwicklungsfassung 0.1.0 auf Feature-Branch.** Die zugrundeliegende Browser-Konsolen-Version wurde praktisch bestätigt. Die Greasemonkey-Variante benötigt noch einen realen Firefox-/Greasemonkey-Smoke-Test, bevor sie als Release gelten kann.

## Installation und Bedienung

1. Für Firefox **Greasemonkey 4.11+** installieren.
2. Die Datei [`userscripts/chatgpt-conversation-export.user.js`](userscripts/chatgpt-conversation-export.user.js) aus diesem Branch in Greasemonkey installieren bzw. als neues Userscript in dessen Editor übernehmen und speichern. Keine manuelle URL-Konfiguration notwendig.
3. Auf `https://chatgpt.com` anmelden und **einen Original-Chat** öffnen: `/c/<uuid>` oder `/g/.../c/<uuid>`.
4. Im Greasemonkey-Menü den Befehl **„Aktuellen Chat als JSON exportieren“** auswählen.
5. Ein kleines Statusfenster zeigt den Abruf an. **Abbrechen** unterbricht die laufende Anfrage, die geladenen Seiten bleiben während der aktuellen Browser-Tab-Sitzung im Speicher. Zum **Fortsetzen denselben Menüpunkt erneut auswählen**.
6. Nach bestätigtem Paginierungsende die Datei `chatgpt-conversation-<uuid>.json` im Browser-Downloadverzeichnis kontrollieren.

**Achtung bei privatem Repository:** Eine direkte GitHub-Raw-Installation und automatische Updates sind möglicherweise nicht verfügbar. Daher vorerst per Greasemonkey-Editor installieren; es sind bewusst keine `@downloadURL`/`@updateURL`-Angaben gesetzt.

Ausführliche Hinweise: [Installation / manueller Smoke-Test](docs/installation-and-validation.md).

## Eigenschaften

- Menüeintrag statt automatischem Export, ohne den Chat-Titel zu benötigen
- Automatische Ermittlung der aktuellen Chat-URL im **Moment des Klicks**
- Authentifizierter Abruf über die bestehende ChatGPT-Sitzung
- Cursor-Paginierung mit `num_turns=1`, `include_has_versions=true`, `before=start_cursor`
- Retry bei HTTP 429/500/502/503/504, Abbruch, Wiederaufnahme ohne erneutes Laden bereits validierter Seiten
- Verhinderung von Cursor-Schleifen; Validierung aller Seiten, Deduplizierung und Audit im JSON
- Statusfenster mit Seiten-/Datensatzanzahl, kein externer Netzwerkdienst
- Keine Laufzeitbibliotheken, keine externen `@require`-Skripte

## Entwicklung

Voraussetzung: Node.js 22 oder höher. Keine zusätzlichen npm-Abhängigkeiten.

```bash
npm run build
npm run check
```

Die **Quellen** liegen in `src/exporter-core.js` (testbare API-/Paginierungslogik) und `src/userscript-entry.js` (Greasemonkey-Menü, Statusfenster, Download). `scripts/build-userscript.js` generiert daraus deterministisch `userscripts/chatgpt-conversation-export.user.js`. Bitte **nicht nur die generierte Datei** bearbeiten. Die CI überprüft Syntax, Bundle-Gleichheit und Node-basierte Tests und vermeidet Push+PR-Doppelruns: Push nur auf `main`, PR auf Feature-Branches. Reine Dokumentationsänderungen lösen keine CI aus.

Architektur und Grenzen: [Technische Dokumentation](docs/architecture-and-limitations.md).

## Herkunft und Evidenz

Die Logik basiert auf einem mehrfach erfolgreich getesteten JavaScript-Konsolenexport aus dem Lyrion-Projekt. Am 31. Oktober 2026 lieferte die URL-basierte V2-Version bei einem langen Original-Chat **64 Seiten, 4.970 eindeutige Datensätze, keine Duplikate und 55,35 MiB**; der End-Cursor meldete `has_previous_page=false`. Die automatische URL-Ermittlung über `window.location.origin + window.location.pathname` wurde ebenfalls bestätigt. **Diese Zahlen gelten nicht als Greasemonkey-Test** und sind nicht für andere Unterhaltungen zu erwarten. Private Chat-IDs, Prompts und JSON-Exporte werden nicht ins Repository übernommen.

## Sicherheit und Einschränkungen

Die ChatGPT-Endpunkte sind intern und undokumentiert; Änderungen können das Userscript jederzeit unbrauchbar machen. Es funktioniert nur für **berechtigt zugängliche Original-Chats**, nicht für `/share/...`-Links. Der JSON-Export enthält unter Umständen interne Tool-Datensätze, personenbezogene Informationen, Pfade, Referenzen oder vertrauliche Inhalte. Anhänge werden **nicht separat heruntergeladen**. `pagination_verified=true` bestätigt nur das von der API gemeldete Ende der Seitenfolge, nicht sämtliche Versionen oder Branches.

Das Userscript ruft nur relative Endpunkte von `chatgpt.com` auf und lädt die JSON lokal herunter; es sendet keine Chat-Daten an GitHub oder andere Dienste. Der Sitzungstoken wird für authentifizierte Anfragen verwendet und nicht in die JSON geschrieben. **Exportdateien keinesfalls committen oder ungeprüft weitergeben.**

Für den offiziell unterstützten Gesamtexport: ChatGPT → Einstellungen → Datenkontrollen → Daten exportieren.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
