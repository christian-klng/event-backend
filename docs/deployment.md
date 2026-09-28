# Deployment mit Coolify

Schritt für Schritt vom leeren Server bis zum ersten Testkauf. Platzhalter in dieser Anleitung: `events.example.de` für die Adresse des Dienstes, `www.example.de` für die Webseite.

## 1. Vorbereitung

| Was | Wofür |
|---|---|
| DNS-Eintrag `events.example.de` auf die IP des Hetzner-Servers | Adresse des Dienstes, Coolify holt das Zertifikat selbst |
| S3-Speicher, z. B. Hetzner Object Storage | Ziel für die Datenbank-Backups |
| Stripe-Konto mit Testschlüssel | Bezahlung |
| Postfach mit SMTP-Zugang | Bestätigungs-Mails |

## 2. Datenbank

1. In Coolify **+ New → Database → PostgreSQL** (Version 17) anlegen und starten.
2. Die **interne** Verbindungs-URL kopieren (`postgres://…`). Die Datenbank braucht keinen öffentlichen Port.
3. Unter **Backups → + Add** ein tägliches Backup einrichten.
4. Im Backup den Abschnitt **S3** aktivieren und den S3-Speicher auswählen.

Die Thumbnails liegen in der Datenbank. Das Backup enthält damit alle Daten des Dienstes.

## 3. Anwendung

1. **+ New → Private Repository (with GitHub App)**, Repo `event-backend`, Branch `main`.
2. Build Pack **Dockerfile**, Port **3000**.
3. Domain `https://events.example.de` eintragen.
4. Umgebungsvariablen setzen (siehe unten).
5. **Deploy**.

Den Health Check bringt das Dockerfile mit. Coolify verwendet ihn automatisch, in der Oberfläche ist dafür nichts einzustellen.

### Umgebungsvariablen

| Variable | Wert |
|---|---|
| `ADMIN_TOKEN` | Zufallswert, siehe unten |
| `APP_SECRET` | Zweiter Zufallswert |
| `PUBLIC_BASE_URL` | `https://events.example.de` |
| `DATABASE_URL` | Interne Postgres-URL aus Schritt 2 |
| `STRIPE_SECRET_KEY` | Stripe-Testschlüssel, später der Live-Schlüssel |

Zufallswerte erzeugen, je einmal für `ADMIN_TOKEN` und `APP_SECRET`:

```bash
openssl rand -base64 48 | tr -d '/+=\n'
```

`APP_SECRET` verschlüsselt die in der Datenbank gespeicherten Zugangsdaten. Wer den Wert ändert, muss SMTP-Passwort und Webhook danach neu setzen. Beide Werte gehören in einen Passwortmanager.

### Stripe-Schlüssel

Ein eingeschränkter Schlüssel genügt. Anlegen unter **Entwickler → API-Schlüssel → Eingeschränkten Schlüssel erstellen** mit Schreibrechten für:

- Checkout Sessions
- Tax Rates
- Credit Notes
- Refunds (Erstattungen)
- Webhook Endpoints

## 4. Prüfen

```bash
curl https://events.example.de/healthz
```

Die Antwort ist `{"ok":true}`.

## 5. Claude verbinden

```bash
claude mcp add --transport http events https://events.example.de/mcp --header "Authorization: Bearer <ADMIN_TOKEN>"
```

## 6. Verkauf einrichten

Diese Schritte erledigt Claude über den MCP-Server. Beispiel für den Auftrag:

> Richte den Ticketverkauf ein: Veranstalter „Beispiel Akademie", Webseite https://www.example.de, Danke-Seite https://www.example.de/danke, Abbruch-Seite https://www.example.de/seminare, AGB https://www.example.de/agb, Steuersatz 19 %. Lege den Stripe-Webhook an und zeig mir danach den Stripe-Status.

| Tool | Wirkung |
|---|---|
| `update_settings` | Veranstalter, Seiten, erlaubte Webseite (`allowed_origins`), Steuersatz |
| `create_stripe_webhook` | Meldet den Dienst bei Stripe an |
| `update_mail_settings` | Postfach für Bestätigungs-Mails |
| `send_test_email` | Prüft das Postfach |
| `get_stripe_status` | Zeigt, was noch fehlt |

Das SMTP-Passwort steht im Chatverlauf, wenn es über `update_mail_settings` gesetzt wird. Wer das vermeiden will, setzt stattdessen `SMTP_PASSWORD` als Umgebungsvariable in Coolify.

## 7. Testkauf

1. Mit Claude ein Test-Event anlegen und veröffentlichen, je ein Ticket-Typ für Präsenz und Online.
2. Den Kauf starten. Solange die Webseite noch nicht angebunden ist, geht das so:

```bash
curl -X POST https://events.example.de/v1/checkout -H 'content-type: application/json' -d '{"ticket_type_id":"<ID>","quantity":1}'
```

3. Die Adresse aus `checkout_url` im Browser öffnen und mit der Testkarte `4242 4242 4242 4242` bezahlen (beliebiges Ablaufdatum in der Zukunft, beliebige Prüfziffer).

### Checkliste

| Prüfen | Erwartung |
|---|---|
| Bezahlseite | Titel, Termin, Preis inklusive Steuer, Hinweis auf die AGB |
| Felder auf der Bezahlseite | Rechnungsadresse Pflicht, USt-ID für Firmen möglich |
| Weiterleitung | Danke-Seite mit `?session_id=…` |
| `list_orders` | Bestellung mit Status `paid` |
| Bestätigungs-Mail | Zugangslink (Online) oder Ort (Präsenz), Kalenderdatei im Anhang |
| Rechnung von Stripe | Firmendaten, Steuersatz, Rechnungsnummer |
| `refund_order` | Status `refunded`, Gutschrift in Stripe, Platz wieder frei |
| Bezahlseite offen lassen, nicht zahlen | Platz nach rund 35 Minuten wieder frei |

Im Testmodus verschickt Stripe Rechnungs-Mails nicht automatisch. Die Rechnung ist im Stripe-Dashboard bei der Zahlung zu sehen.

## 8. Live schalten

1. In Stripe Firmendaten, Rechnungsnummernkreis und Absender-Angaben für Rechnungen prüfen.
2. `STRIPE_SECRET_KEY` in Coolify durch den Live-Schlüssel ersetzen und neu deployen.
3. `create_stripe_webhook` erneut ausführen, weil Stripe Webhooks pro Modus getrennt führt.
4. `get_stripe_status` muss `mode: live` und `ready_for_sales: true` zeigen.
5. Test-Events archivieren.

## 9. Betrieb

| Aufgabe | Rhythmus |
|---|---|
| Wiederherstellung eines Backups in eine Testdatenbank proben | einmal nach der Einrichtung, danach halbjährlich |
| Coolify und Server aktualisieren | monatlich |
| Externen Uptime-Check auf `/healthz` einrichten | einmalig |

Deployments laufen ohne Unterbrechung: Coolify startet den neuen Container, wartet auf den Health Check und beendet erst dann den alten. Datenbank-Migrationen laufen beim Start automatisch.

Fällt der Dienst kurz aus, gehen keine Zahlungen verloren. Stripe stellt Webhooks bis zu drei Tage lang erneut zu.
