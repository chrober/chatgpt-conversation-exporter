# Installation, Bedienung und Firefox-Abnahme

> Entwicklungsstand 0.1.1 (Tampermonkey + Greasemonkey). Die Konsole wurde real erfolgreich getestet, **nicht jedoch bereits die Userscript-Sandbox**.

## Vorbereitungen

- Firefox mit **Tampermonkey** oder Greasemonkey **4.11+**. Das Script unterstützt `GM_registerMenuCommand` und `GM.registerMenuCommand` und bietet zusätzlich einen immer sichtbaren Export-Button.
- Bei `https://chatgpt.com` angemeldet sein und Zugriff auf den **Original-Chat** haben.
- Genügend freier RAM und Festplattenspeicher; lange Chats können mehrere Dutzend MiB JSON erzeugen.
- Das GitHub-Repository ist **öffentlich**. [V0.1.1 direkt aus dem Feature-Branch installieren](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/refs/heads/feat/greasemonkey-single-conversation-export/userscripts/chatgpt-conversation-export.user.js). Falls Firefox keine Installation anbietet, den Raw-Inhalt in den Userscript-Editor einfügen. Eine vorhandene V0.1.0-Installation auf V0.1.1 aktualisieren oder ersetzen. Es gibt keine externen Bibliotheken.

## Bedienung

1. Original-Chat öffnen, etwa `https://chatgpt.com/c/<conversation-id>` oder `https://chatgpt.com/g/<projekt>/c/<conversation-id>`. **Nach Installation/Update Chat-Tab neu laden.**
2. **Unten links auf der ChatGPT-Seite „Chat als JSON exportieren“ klicken.** Optional über den Greasemonkey-/Tampermonkey-Menüpunkt **„Aktuellen Chat als JSON exportieren“** starten. In Tampermonkey öffnet der Pfeil rechts neben dem Script-Namen lediglich **Bearbeiten / Problem melden / Löschen**, nicht die Exportaktion.
3. Im Statusfenster Seiten- und Datensatzanzahl beobachten. Der Export startet **nur nach der Klickaktion**.
4. Bei Bedarf **Abbrechen** wählen; die zuletzt erfolgreich validierten Seiten bleiben im Speicher des aktuellen Browser-Tabs. Erneut denselben Button bzw. Menüpunkt auswählen, um fortzusetzen.
5. Nach **Export abgeschlossen – Download gestartet** die Datei `chatgpt-conversation-<conversation-id>.json` im Browser-Downloadverzeichnis kontrollieren.
6. JSON prüfen: `messages` als Array, `page_metadata`, `local_export_audit.pagination_verified === true`, `local_export_audit.unique_records` plausibel, zuletzt `has_previous_page=false`. Anfang und Ende des Verlaufs stichprobenartig mit dem Original abgleichen.

Das Statusfenster zeigt **keine Nachrichteninhalte** an. Bei einem Chat-Wechsel während des Exports bricht der Abruf ab, damit nicht unbeabsichtigt verschiedene Unterhaltungen zusammengeführt werden. Nach Rückkehr zum Original-Chat kann der Zwischenstand im selben Tab fortgesetzt werden. **Ein Reload / Tab-Schließen löscht den Zwischenstand.**

## Manuelle Abnahmetests – vor einer Freigabe erforderlich

- [ ] Tampermonkey-/Greasemonkey-Menübefehl erscheint auf dem ChatGPT-Tab (falls vom Manager unterstützt).
- [ ] Der **„Chat als JSON exportieren“**-Button unten links erscheint in Firefox auch ohne Menübefehl.
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
| Menüpunkt fehlt | Der Pfeil neben dem installierten Script in Tampermonkey zeigt nur Verwaltungsaktionen. **ChatGPT-Tab neu laden und unten links den Export-Button verwenden.** Scriptversion 0.1.1 sowie Grants `GM_registerMenuCommand` / `GM.registerMenuCommand` prüfen. |
| `HTTP 401/403` | Angemeldete Sitzung und Sandbox-Zugriff prüfen; keine Token in Tickets posten. |
| `HTTP 500 Request timeout` | Die Kernlogik nutzt direkte, kleine Paginierungsabfragen und wiederholt temporäre Fehler. |
| `Paginierungsstatus fehlt`, leere Seite, Cursor wiederholt | API-Schema oder Daten verändert: bewusst **kein** Teil-Export; Diagnose ohne vertrauliche Daten erstellen. |
| Datei nicht sichtbar | Browser-Downloadeinstellungen / Pop-up-/Dateidownloadberechtigung prüfen; Greasemonkey-Dateidownload im echten Firefox testen. |
| Export abgebrochen | Gleiches Tab und gleiche Unterhaltung verwenden, Menüpunkt erneut aufrufen. |

Das Userscript setzt bis zur ersten stabilen Version **keine** `@updateURL`/`@downloadURL`. Das Repository ist jetzt öffentlich, aber die Entwicklungsfassung wird noch direkt vom Feature-Branch installiert.
