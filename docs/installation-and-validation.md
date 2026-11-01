# Installation, Bedienung und Firefox-Abnahme

> Entwicklungsstand 0.1.9 (Tampermonkey + Greasemonkey). Die Version 0.1.1 wurde mit **Tampermonkey unter Firefox erfolgreich ausgeführt**. Der neue Fast-Modus (`num_turns=2`, 100 ms) und der Fix beim Re-Export nach Close müssen im realen Firefox/Tampermonkey geprüft werden.

## Vorbereitungen

- Firefox mit **Tampermonkey** oder Greasemonkey **4.11+**. Das Script unterstützt `GM_registerMenuCommand` und `GM.registerMenuCommand` und bietet zusätzlich einen immer sichtbaren Export-Button.
- Bei `https://chatgpt.com` angemeldet sein und Zugriff auf den **Original-Chat** haben.
- Genügend freier RAM und Festplattenspeicher; lange Chats können mehrere Dutzend MiB JSON erzeugen.
- Das GitHub-Repository ist **öffentlich**. [V0.1.9 direkt aus dem Feature-Branch installieren](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/refs/heads/feat/greasemonkey-single-conversation-export/userscripts/chatgpt-conversation-export.user.js). Falls Firefox keine Installation anbietet, den Raw-Inhalt in den Userscript-Editor einfügen. Eine vorhandene V0.1.0-/V0.1.1-Installation auf V0.1.9 aktualisieren oder ersetzen. Es gibt keine externen Bibliotheken.

## Bedienung

1. Original-Chat öffnen, etwa `https://chatgpt.com/c/<conversation-id>` oder `https://chatgpt.com/g/<projekt>/c/<conversation-id>`. **Nach Installation/Update Chat-Tab neu laden.**
2. **Unten rechts auf der ChatGPT-Seite „Export chat as JSON“ klicken.** Optional über den Greasemonkey-/Tampermonkey-Menüpunkt **„Export current chat as JSON“** starten. In Tampermonkey öffnet der Pfeil rechts neben dem Script-Namen lediglich **Bearbeiten / Problem melden / Löschen**, nicht die Exportaktion.
3. Im Statusfenster oberhalb des Buttons **API pages** (paginierte HTTP-Antworten, keine UI-Seiten) und **message records** (technische Nachrichtenobjekte) beobachten. Der Export startet **nur nach der Klickaktion**.
4. **Cancel** ist ausschließlich während eines laufenden Exports sichtbar. Nach Erfolg, Abbruch oder Fehler **verschwindet Cancel** und wird durch **Save performance report** ersetzt. **Close** schließt dagegen ausschließlich das Fortschrittsfenster: Der Export läuft im aktuellen Tab weiter und öffnet das Fenster nicht automatisch erneut. **Ein rotierender Spinner rechts im Export-Hauptbutton zeigt die Aktivität weiterhin an**, auch wenn das Fenster geschlossen wurde. Bei laufendem Export zeigt ein erneuter Klick auf **Export chat as JSON** das Fenster wieder mit dem aktuellen Fortschritt und aktivem **Cancel** – ohne weitere Exportinstanz oder doppelte Abfragen. Nach einem tatsächlichen Abbruch setzt ein erneuter Klick den Export ab der letzten validierten API-Seite fort.
5. Nach **Export complete – ZIP download started** die Datei `chatgpt-conversation-<conversation-id>.zip` herunterladen und entpacken. Darin liegt die vollständige `chatgpt-conversation-<conversation-id>.json`. Wenn die native Browser-Komprimierung ausfällt, wird stattdessen automatisch das unkomprimierte `.json` gespeichert und dies im Statusfenster vermerkt.
6. Entpacktes oder direkt heruntergeladenes JSON prüfen: `messages` als Array, `page_metadata`, `local_export_audit.pagination_verified === true`, `local_export_audit.unique_records` plausibel, zuletzt `has_previous_page=false`. Anfang und Ende des Verlaufs stichprobenartig mit dem Original abgleichen.

**Performance-Modus 0.1.9:** Das Userscript verwendet versuchsweise `num_turns=2` und eine Pause von 100 ms zwischen API-Seiten. Nach wiederholten temporären Backend-/Netzwerkfehlern einer Abfrage fällt es auf das bewährte `num_turns=1` zurück. In neuen Performance-Reports stehen `summary.requests_by_num_turns` und `requests[*].num_turns`. Dies ist ein **Experiment**, kein belegter Speedup. Für einen echten Vergleich **den ChatGPT-Tab neu laden und dieselbe Unterhaltung neu exportieren**; sonst kann der Exporter die bereits vollständig im Tab gespeicherten Nachrichten verwenden und einen neuen Download ohne API-Abrufe erzeugen.

Das Statusfenster zeigt **keine Nachrichteninhalte** an. **Save performance report** ist während des laufenden Exports vollständig verborgen und erscheint erst **nach Abschluss, Abbruch oder Fehler**. Damit lässt sich ein separates Diagnose-JSON speichern. Das geschieht **nur auf ausdrücklichen Klick**, nicht automatisch. Der Bericht enthält weder vollständige Chat-URL noch Conversation-ID, Cursor, Token oder Nachrichteninhalte; Zeitstempel, Antwortstatus, Zeitmessungen und Datensatzanzahlen sind enthalten. Bei einem Chat-Wechsel während des Exports bricht der Abruf ab, damit nicht unbeabsichtigt verschiedene Unterhaltungen zusammengeführt werden. Nach Rückkehr zum Original-Chat kann der Zwischenstand im selben Tab fortgesetzt werden. **Ein Reload / Tab-Schließen löscht den Zwischenstand.**

## Manuelle Abnahmetests – vor einer Freigabe erforderlich

- [ ] Tampermonkey-/Greasemonkey-Menübefehl erscheint auf dem ChatGPT-Tab (falls vom Manager unterstützt).
- [ ] Der **„Export chat as JSON“**-Button unten rechts erscheint in Firefox auch ohne Menübefehl und verdeckt das ChatGPT-Menü nicht.
- [ ] Fortschrittsfenster erscheint direkt über dem Button; alle Statusmeldungen sind auf Englisch.
- [ ] **Cancel** ist während eines laufenden Exports sichtbar, **Save performance report** ist verborgen. Nach Erfolg, Fehler und Abbruch verschwindet Cancel vollständig; Save performance report erscheint an dessen Stelle, und Close bleibt sichtbar.
- [ ] Nach erfolgreich beendetem Export auf **Close** klicken und denselben Chat erneut exportieren: es wird ein ZIP erstellt; nach erneutem Abschluss bleibt **Cancel vollständig verborgen**, Save performance report ist sichtbar und der Spinner stoppt.
- [ ] Mit `num_turns=2` bleibt `pagination_verified=true` und dieselbe Unterhaltung liefert dieselben eindeutigen Datensätze wie der Referenzexport `num_turns=1`; Dauer, Anfrageanzahl, Fehler und ZIP-Größe vergleichen.
- [ ] Während eines laufenden Exports auf **Close** klicken: das Fenster bleibt trotz weiterer API-Seiten und Abschluss geschlossen; der **Spinner im Hauptbutton dreht sich weiter** und der Download wird trotzdem fertiggestellt.
- [ ] Spinner ist bei inaktivem Export verborgen, während API-Abrufen und ZIP-Komprimierung sichtbar und verschwindet bei Erfolg, Abbruch oder Fehler. Erneutes Öffnen des Statusfensters unterbricht die Animation nicht.
- [ ] Während eines laufenden Exports nach **Close** den Export-Button erneut drücken: Statusfenster erscheint mit aktuellem Fortschritt, **Cancel** ist aktiv; keine zweite Exportinstanz startet.
- [ ] **Save performance report** ist während des Abrufs und der ZIP-Komprimierung **nicht sichtbar**; nach Erfolg, Abbruch oder Fehler wird es eingeblendet.
- [ ] Der Performance-Bericht enthält HTTP-Status, Fetch-/Parsezeiten und nach erfolgreichem Export `zip_compression_ms`, `archive_bytes` und `compression_ratio`; keine Chat-ID, URL, Cursor oder Inhalte.
- [ ] ZIP enthält exakt eine `.json`-Datei und lässt sich mit ZIP-Werkzeugen entpacken; JSON-Inhalt, CRC32 und Audit stimmen. Komprimierte und unkomprimierte Größe plausibel.
- [ ] Falls ZIP nicht unterstützt wird, erfolgt ein gekennzeichneter unkomprimierter JSON-Fallback ohne Datenverlust.
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

**Browserstatus:** Tampermonkey-Version 0.1.1 ist vom Anwender erfolgreich getestet. Der neue 0.1.9-Build muss noch überprüft werden. Automatisierte Tests können reale Firefox-Sandbox-, Layout- und Downloadprobleme nicht vollständig ausschließen.

## Fehlerdiagnose

| Beobachtung | Maßnahme |
| --- | --- |
| Menüpunkt fehlt | Der Pfeil neben dem installierten Script in Tampermonkey zeigt nur Verwaltungsaktionen. **ChatGPT-Tab neu laden und unten rechts den Export-Button verwenden.** Scriptversion 0.1.9 sowie Grants `GM_registerMenuCommand` / `GM.registerMenuCommand` prüfen. |
| `HTTP 401/403` | Angemeldete Sitzung und Sandbox-Zugriff prüfen; keine Token in Tickets posten. |
| `HTTP 500 Request timeout` | Die Kernlogik nutzt direkte, kleine Paginierungsabfragen und wiederholt temporäre Fehler. |
| `Paginierungsstatus fehlt`, leere Seite, Cursor wiederholt | API-Schema oder Daten verändert: bewusst **kein** Teil-Export; Diagnose ohne vertrauliche Daten erstellen. |
| Datei nicht sichtbar | Browser-Downloadeinstellungen / Pop-up-/Dateidownloadberechtigung prüfen; Greasemonkey-Dateidownload im echten Firefox testen. |
| Export abgebrochen | Gleiches Tab und gleiche Unterhaltung verwenden, Button oder Menüpunkt erneut aufrufen. |
| Profiling-Bericht enthält keine Serialisierungszeit | Nur bei erfolgreicher Downloadvorbereitung werden die Serialisierungs-/ZIP-Phasen gemessen; nach Abbruch/Fehler bleiben sie `null`. |
| Statt `.zip` wird `.json` gespeichert | Der Browser unterstützt `CompressionStream('deflate-raw')` nicht oder eine Komprimierungsoperation ist fehlgeschlagen. Der Exporter informiert über den sicheren Fallback. |
| `API pages` unterschiedlich groß | Jede API-Seite umfasst unterschiedlich viele technische `message records`; `num_turns=1` bedeutet **nicht** ein Datensatz pro API-Seite. |

Das Userscript setzt bis zur ersten stabilen Version **keine** `@updateURL`/`@downloadURL`. Das Repository ist jetzt öffentlich, aber die Entwicklungsfassung wird noch direkt vom Feature-Branch installiert.
