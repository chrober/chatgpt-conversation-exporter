# Installation, Bedienung und Firefox-Abnahme

> Entwicklungsstand 0.1.0. Die Konsole wurde real erfolgreich getestet, **nicht jedoch bereits die Userscript-Sandbox**.

## Vorbereitungen

- Firefox mit Greasemonkey **4.11 oder neuer** (für `GM.registerMenuCommand`).
- Bei `https://chatgpt.com` angemeldet sein und Zugriff auf den **Original-Chat** haben.
- Genügend freier RAM und Festplattenspeicher; lange Chats können mehrere Dutzend MiB JSON erzeugen.
- Derzeit ist das GitHub-Repository **privat**. Falls GitHub-Raw aus Greasemonkey nicht installierbar ist: Datei `userscripts/chatgpt-conversation-export.user.js` im GitHub-Dateibrowser anzeigen und den **gesamten Inhalt** in einem neuen Greasemonkey-Userscript einfügen; speichern. Es gibt keine externen Bibliotheken.

## Bedienung

1. Original-Chat öffnen, etwa `https://chatgpt.com/c/<conversation-id>` oder `https://chatgpt.com/g/<projekt>/c/<conversation-id>`.
2. Greasemonkey-Symbol in der Firefox-Toolbar öffnen und **Aktuellen Chat als JSON exportieren** wählen.
3. Im Statusfenster Seiten- und Datensatzanzahl beobachten. Der Export startet **nur nach dieser Aktion**.
4. Bei Bedarf **Abbrechen** wählen; die zuletzt erfolgreich validierten Seiten bleiben im Speicher des aktuellen Browser-Tabs. Erneut denselben Greasemonkey-Menüpunkt auswählen, um fortzusetzen.
5. Nach **Export abgeschlossen – Download gestartet** die Datei `chatgpt-conversation-<conversation-id>.json` im Browser-Downloadverzeichnis kontrollieren.
6. JSON prüfen: `messages` als Array, `page_metadata`, `local_export_audit.pagination_verified === true`, `local_export_audit.unique_records` plausibel, zuletzt `has_previous_page=false`. Anfang und Ende des Verlaufs stichprobenartig mit dem Original abgleichen.

Das Statusfenster zeigt **keine Nachrichteninhalte** an. Bei einem Chat-Wechsel während des Exports bricht der Abruf ab, damit nicht unbeabsichtigt verschiedene Unterhaltungen zusammengeführt werden. Nach Rückkehr zum Original-Chat kann der Zwischenstand im selben Tab fortgesetzt werden. **Ein Reload / Tab-Schließen löscht den Zwischenstand.**

## Manuelle Abnahmetests – vor einer Freigabe erforderlich

- [ ] Greasemonkey-Menübefehl ist in Firefox sichtbar, auch in Projekt-Chats.
- [ ] Beim Laden einer Seite **kein automatischer** Chat-Export.
- [ ] Kleiner Original-Chat: Einmal auf Menü klicken; HTTP-Abruf und Download sind erfolgreich, ohne Authentifizierungs-/CSP-/Sandbox-Fehler.
- [ ] JSON öffnet sich, die gemeldete Größe passt zur Datei, `pagination_verified` ist `true`.
- [ ] Langer Chat: Paginierung bis `has_previous_page=false`, keine Seiten-/Cursor-Schleife.
- [ ] Mit **Abbrechen** unterbrechen, dann im **selben Tab** wieder starten; bereits geladene Seiten nicht erneut abrufen.
- [ ] In derselben ChatGPT-Single-Page-App einen anderen Chat öffnen: neue Conversation-ID und neuer Dateiname.
- [ ] Auf einer `/share/...`-Seite oder ohne offenen Chat zeigt der Befehl einen erklärenden Fehler.
- [ ] Downloadberechtigung in Firefox prüfen; browserseitige Sperren gegebenenfalls nachvollziehen.
- [ ] Keine Chat- oder Authentifizierungsdaten werden an andere Origins gesendet.
- [ ] Kein privates JSON, kein Zugriffstoken in Git oder CI-Test-Logs.

**Noch nicht abgehakt:** Diese realen Browserprüfungen erfordern Firefox/Greasemonkey mit angemeldetem Benutzer und werden von den Node-Unit-Tests **nicht** abgedeckt.

## Fehlerdiagnose

| Beobachtung | Maßnahme |
| --- | --- |
| Menüpunkt fehlt | Greasemonkey 4.11+, Script aktiviert, richtige `@match`-Domain und `@grant GM.registerMenuCommand` prüfen. |
| `HTTP 401/403` | Angemeldete Sitzung und Sandbox-Zugriff prüfen; keine Token in Tickets posten. |
| `HTTP 500 Request timeout` | Die Kernlogik nutzt direkte, kleine Paginierungsabfragen und wiederholt temporäre Fehler. |
| `Paginierungsstatus fehlt`, leere Seite, Cursor wiederholt | API-Schema oder Daten verändert: bewusst **kein** Teil-Export; Diagnose ohne vertrauliche Daten erstellen. |
| Datei nicht sichtbar | Browser-Downloadeinstellungen / Pop-up-/Dateidownloadberechtigung prüfen; Greasemonkey-Dateidownload im echten Firefox testen. |
| Export abgebrochen | Gleiches Tab und gleiche Unterhaltung verwenden, Menüpunkt erneut aufrufen. |

Das Greasemonkey-Userscript setzt **keine** `@updateURL`/`@downloadURL`, solange es noch keine öffentlich zugängliche stabile Release-Version gibt.
