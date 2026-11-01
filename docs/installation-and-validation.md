# Installation, Bedienung und Firefox-Abnahme

> Entwicklungsstand 0.1.5 (Tampermonkey + Greasemonkey). Die Version 0.1.1 wurde mit **Tampermonkey unter Firefox erfolgreich ausgeführt**. Die Korrektur des Schließen-/Wiederöffnen-Verhaltens in 0.1.5 muss im Browser gegengeprüft werden.

## Vorbereitungen

- Firefox mit **Tampermonkey** oder Greasemonkey **4.11+**. Das Script unterstützt `GM_registerMenuCommand` und `GM.registerMenuCommand` und bietet zusätzlich einen immer sichtbaren Export-Button.
- Bei `https://chatgpt.com` angemeldet sein und Zugriff auf den **Original-Chat** haben.
- Genügend freier RAM und Festplattenspeicher; lange Chats können mehrere Dutzend MiB JSON erzeugen.
- Das GitHub-Repository ist **öffentlich**. [V0.1.5 direkt aus dem Feature-Branch installieren](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/refs/heads/feat/greasemonkey-single-conversation-export/userscripts/chatgpt-conversation-export.user.js). Falls Firefox keine Installation anbietet, den Raw-Inhalt in den Userscript-Editor einfügen. Eine vorhandene V0.1.0-/V0.1.1-Installation auf V0.1.5 aktualisieren oder ersetzen. Es gibt keine externen Bibliotheken.

## Bedienung

1. Original-Chat öffnen, etwa `https://chatgpt.com/c/<conversation-id>` oder `https://chatgpt.com/g/<projekt>/c/<conversation-id>`. **Nach Installation/Update Chat-Tab neu laden.**
2. **Unten rechts auf der ChatGPT-Seite „Export chat as JSON“ klicken.** Optional über den Greasemonkey-/Tampermonkey-Menüpunkt **„Export current chat as JSON“** starten. In Tampermonkey öffnet der Pfeil rechts neben dem Script-Namen lediglich **Bearbeiten / Problem melden / Löschen**, nicht die Exportaktion.
3. Im Statusfenster oberhalb des Buttons **API pages** (paginierte HTTP-Antworten, keine UI-Seiten) und **message records** (technische Nachrichtenobjekte) beobachten. Der Export startet **nur nach der Klickaktion**.
4. **Cancel** bricht den Export ab und ist nur während eines laufenden Exports aktiv; nach Abschluss, Abbruch oder Fehler ist er **disabled/grau**. **Close** schließt dagegen ausschließlich das Fortschrittsfenster: Der Export läuft im Hintergrund des aktuellen Tabs weiter und öffnet das Fenster nicht automatisch erneut. Bei laufendem Export zeigt ein erneuter Klick auf **Export chat as JSON** das Fenster wieder mit dem aktuellen Fortschritt und aktivem **Cancel** – ohne weitere Exportinstanz oder doppelte Abfragen. Nach einem tatsächlichen Abbruch setzt ein erneuter Klick den Export ab der letzten validierten API-Seite fort.
5. Nach **Export complete – JSON download started** die Datei `chatgpt-conversation-<conversation-id>.json` im Browser-Downloadverzeichnis kontrollieren.
6. JSON prüfen: `messages` als Array, `page_metadata`, `local_export_audit.pagination_verified === true`, `local_export_audit.unique_records` plausibel, zuletzt `has_previous_page=false`. Anfang und Ende des Verlaufs stichprobenartig mit dem Original abgleichen.

Das Statusfenster zeigt **keine Nachrichteninhalte** an. Mit **Save performance report** lässt sich nach mindestens einem HTTP-Versuch ein separates Diagnose-JSON speichern. Das geschieht **nur auf ausdrücklichen Klick**, nicht automatisch. Der Bericht enthält weder vollständige Chat-URL noch Conversation-ID, Cursor, Token oder Nachrichteninhalte; Zeitstempel, Antwortstatus, Zeitmessungen und Datensatzanzahlen sind enthalten. Bei einem Chat-Wechsel während des Exports bricht der Abruf ab, damit nicht unbeabsichtigt verschiedene Unterhaltungen zusammengeführt werden. Nach Rückkehr zum Original-Chat kann der Zwischenstand im selben Tab fortgesetzt werden. **Ein Reload / Tab-Schließen löscht den Zwischenstand.**

## Manuelle Abnahmetests – vor einer Freigabe erforderlich

- [ ] Tampermonkey-/Greasemonkey-Menübefehl erscheint auf dem ChatGPT-Tab (falls vom Manager unterstützt).
- [ ] Der **„Export chat as JSON“**-Button unten rechts erscheint in Firefox auch ohne Menübefehl und verdeckt das ChatGPT-Menü nicht.
- [ ] Fortschrittsfenster erscheint direkt über dem Button; alle Statusmeldungen sind auf Englisch.
- [ ] **Cancel** ist während eines Exports aktiv und anschließend sichtbar grau/deaktiviert; der Profiling-Download funktioniert weiterhin.
- [ ] Während eines laufenden Exports auf **Close** klicken: das Fenster bleibt trotz weiterer API-Seiten und Abschluss geschlossen; der Download wird trotzdem fertiggestellt.
- [ ] Während eines laufenden Exports nach **Close** den Export-Button erneut drücken: Statusfenster erscheint mit aktuellem Fortschritt, **Cancel** ist aktiv; keine zweite Exportinstanz startet.
- [ ] **Save performance report** erzeugt ein valides Diagnose-JSON; enthält HTTP-Status, Fetch-/Parsezeiten, API-Seitenstatistik, Serialisierungszeit (nach vollständig abgeschlossenem Export), aber keine Chat-ID, URL, Cursor oder Inhalte.
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

**Browserstatus:** Tampermonkey-Version 0.1.1 ist vom Anwender erfolgreich getestet. Der neue 0.1.5-Build muss noch überprüft werden. Automatisierte Tests können reale Firefox-Sandbox-, Layout- und Downloadprobleme nicht vollständig ausschließen.

## Fehlerdiagnose

| Beobachtung | Maßnahme |
| --- | --- |
| Menüpunkt fehlt | Der Pfeil neben dem installierten Script in Tampermonkey zeigt nur Verwaltungsaktionen. **ChatGPT-Tab neu laden und unten rechts den Export-Button verwenden.** Scriptversion 0.1.5 sowie Grants `GM_registerMenuCommand` / `GM.registerMenuCommand` prüfen. |
| `HTTP 401/403` | Angemeldete Sitzung und Sandbox-Zugriff prüfen; keine Token in Tickets posten. |
| `HTTP 500 Request timeout` | Die Kernlogik nutzt direkte, kleine Paginierungsabfragen und wiederholt temporäre Fehler. |
| `Paginierungsstatus fehlt`, leere Seite, Cursor wiederholt | API-Schema oder Daten verändert: bewusst **kein** Teil-Export; Diagnose ohne vertrauliche Daten erstellen. |
| Datei nicht sichtbar | Browser-Downloadeinstellungen / Pop-up-/Dateidownloadberechtigung prüfen; Greasemonkey-Dateidownload im echten Firefox testen. |
| Export abgebrochen | Gleiches Tab und gleiche Unterhaltung verwenden, Button oder Menüpunkt erneut aufrufen. |
| Profiling-Bericht enthält keine Serialisierungszeit | Nur bei vollständig heruntergeladenem JSON wird die Serialisierungsphase ermittelt; bei einem Abbruch bleibt der Wert `null`. |
| `API pages` unterschiedlich groß | Jede API-Seite umfasst unterschiedlich viele technische `message records`; `num_turns=1` bedeutet **nicht** ein Datensatz pro API-Seite. |

Das Userscript setzt bis zur ersten stabilen Version **keine** `@updateURL`/`@downloadURL`. Das Repository ist jetzt öffentlich, aber die Entwicklungsfassung wird noch direkt vom Feature-Branch installiert.
