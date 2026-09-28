# event-backend

Kleiner Dienst für den Verkauf von Seminaren und Workshops über die eigene Webseite.

- **Öffentliche API** für Event-Liste und Detailansicht auf der Webseite
- **MCP-Server** zum Anlegen und Verwalten der Events mit Claude
- **Bezahlung** über Stripe Checkout mit Platzreservierung, Rechnung und Bestätigungs-Mail

## Stand

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Grundgerüst, Datenbank, Lese-API, MCP-Tools für Events, Thumbnails und Einstellungen | fertig |
| 2 | Stripe Checkout, Webhooks, Platzreservierung, Mails an Käufer, Erstattungen | fertig, Testkauf mit echtem Stripe-Konto steht aus |
| 3 | Snippet für die Webseite, Danke-Seite | offen |
| 4 | Deployment auf Coolify, Stripe live | offen |

## Lokal starten

Voraussetzung ist Node.js 24. Eine Datenbank muss nicht installiert sein: Ohne `DATABASE_URL` nutzt der Dienst eine eingebettete Postgres-Variante im Ordner `.data/`.

```bash
cp .env.example .env
```

In `.env` die beiden Geheimnisse `ADMIN_TOKEN` und `APP_SECRET` eintragen, jeweils erzeugt mit `openssl rand -base64 48`.

```bash
npm install
```

```bash
npm run dev
```

## Konfiguration

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `ADMIN_TOKEN` | ja | Bearer-Token für den MCP-Server, mindestens 32 Zeichen |
| `APP_SECRET` | ja | Schlüssel für verschlüsselt gespeicherte Werte wie das SMTP-Passwort, mindestens 32 Zeichen |
| `PUBLIC_BASE_URL` | ja (Produktion) | Öffentliche Adresse des Dienstes, z. B. `https://events.example.de` |
| `DATABASE_URL` | ja (Produktion) | `postgres://…` |
| `PORT` | nein | Standard `3000` |
| `SMTP_PASSWORD` | nein | Hat Vorrang vor dem per MCP gespeicherten SMTP-Passwort |
| `STRIPE_SECRET_KEY` | nein | Hat Vorrang vor dem per MCP gespeicherten Stripe-Schlüssel |
| `STRIPE_WEBHOOK_SECRET` | nein | Hat Vorrang vor dem per MCP gespeicherten Webhook-Secret |

`APP_SECRET` darf sich nach der Einrichtung nicht mehr ändern, sonst müssen SMTP-Passwort und Stripe-Schlüssel neu gesetzt werden.

## Öffentliche API

| Endpunkt | Zweck |
|---|---|
| `GET /v1/events` | Veröffentlichte, kommende Events. `?when=past` oder `?when=all` für vergangene |
| `GET /v1/events/:slug` | Ein Event mit Beschreibung (HTML) und Ticket-Typen |
| `POST /v1/checkout` | Reserviert Plätze und liefert die Adresse der Stripe-Bezahlseite |
| `GET /v1/orders/status?session_id=…` | Ergebnis eines Kaufs für die Danke-Seite |
| `GET /media/:hash/large.webp` | Thumbnail, maximal 1600 px breit |
| `GET /media/:hash/small.webp` | Thumbnail, maximal 640 px breit |
| `POST /webhooks/stripe` | Zahlungsereignisse von Stripe |
| `GET /healthz` | Health Check |

Entwürfe und archivierte Events sind nie sichtbar. Die Online-URL und Verkaufszahlen erscheinen nie in der öffentlichen API. Die Zahl freier Plätze (`remaining`) wird nur geliefert, wenn sie den Schwellenwert `low_stock_threshold` erreicht oder unterschreitet.

Preise sind Bruttobeträge in Cent (`49000` = 490,00 €).

### Ticket kaufen

```js
const response = await fetch('https://events.example.de/v1/checkout', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ticket_type_id: '…', quantity: 1 }),
});
const result = await response.json();
if (response.ok) location.href = result.checkout_url;
```

Die Plätze sind ab diesem Moment rund eine halbe Stunde reserviert. Nach der Zahlung leitet Stripe auf `checkout_success_url` weiter und hängt `?session_id=…` an.

Fehler enthalten ein Feld `reason`, zu dem die Webseite einen eigenen Text zeigen kann:

| Status | `reason` | Bedeutung |
|---|---|---|
| 409 | `sold_out` | Ausgebucht |
| 409 | `not_enough_seats` | Weniger Plätze frei als gewünscht |
| 409 | `not_on_sale` | Verkauf noch nicht gestartet, beendet oder Event abgesagt |
| 400 | `quantity` | Menge über dem Maximum pro Bestellung |
| 429 | – | Zu viele Versuche, höchstens 10 Käufe in 10 Minuten pro Besucher |
| 503 | `not_configured`, `payment_provider` | Verkauf derzeit nicht möglich |

## Verkauf einrichten

Alle Schritte laufen über MCP, `get_stripe_status` zeigt jederzeit, was noch fehlt.

1. `update_settings`: `checkout_success_url`, `checkout_cancel_url`, `default_tax_percent` und optional `terms_url` setzen.
2. `update_stripe_settings`: Stripe-Schlüssel hinterlegen, zuerst einen Testschlüssel.
3. `create_stripe_webhook`: meldet den Dienst bei Stripe an und speichert das Webhook-Secret.
4. `update_mail_settings` und `send_test_email`: Postfach für die Bestätigungs-Mails.

`default_tax_percent` ist absichtlich nicht vorbelegt. Solange der Wert fehlt, bleibt der Verkauf geschlossen. `0` bedeutet, dass keine Steuer ausgewiesen wird; ein Hinweis dazu gehört dann in `invoice_footer`.

Ein eingeschränkter Stripe-Schlüssel (`rk_…`) genügt. Er braucht Schreibrechte für Checkout Sessions, Tax Rates, Credit Notes, Refunds und Webhook Endpoints.

### Ablauf eines Kaufs

| Ereignis | Wirkung |
|---|---|
| Kauf gestartet | Bestellung `pending`, Plätze reserviert |
| Zahlung bestätigt | Bestellung `paid`, Bestätigungs-Mail mit Zugangslink oder Ort und Kalenderdatei |
| Bezahlseite abgelaufen | Bestellung `expired`, Plätze wieder frei |
| Erstattung | Bestellung `refunded`, Plätze wieder frei, Rechnungskorrektur bei Stripe |

Schlägt der Mailversand fehl, versucht es der Dienst bis zu sechsmal im Abstand von zehn Minuten erneut. Die Rechnung verschickt Stripe selbst.

## MCP-Server

Der Endpunkt ist `POST /mcp` (Streamable HTTP, zustandslos) und verlangt den Header `Authorization: Bearer <ADMIN_TOKEN>`.

Verbindung in Claude Code:

```bash
claude mcp add --transport http events https://events.example.de/mcp --header "Authorization: Bearer $ADMIN_TOKEN"
```

| Bereich | Tools |
|---|---|
| Events | `list_events`, `get_event`, `create_event`, `update_event`, `set_event_status`, `duplicate_event`, `delete_event` |
| Ticket-Typen | `add_ticket_type`, `update_ticket_type`, `remove_ticket_type` |
| Thumbnail | `set_event_thumbnail_from_url`, `create_thumbnail_upload`, `remove_event_thumbnail` |
| Bestellungen | `list_orders`, `get_order`, `refund_order`, `resend_confirmation`, `resend_confirmations` |
| Stripe | `get_stripe_status`, `update_stripe_settings`, `create_stripe_webhook` |
| Einstellungen | `get_settings`, `update_settings`, `update_mail_settings`, `send_test_email` |

Für ein lokales Bild liefert `create_thumbnail_upload` einen einmalig gültigen Link (15 Minuten). Der Upload läuft per HTTP PUT:

```bash
curl --fail-with-body -T "./bild.jpg" "https://events.example.de/uploads/<token>"
```

### Event-Status

| Status | Auf der Webseite | Wechsel möglich zu |
|---|---|---|
| `draft` (Entwurf) | unsichtbar | `published`, `archived` |
| `published` | sichtbar, buchbar | `draft`, `cancelled`, `archived` |
| `cancelled` | sichtbar als abgesagt | `archived` |
| `archived` | unsichtbar | `draft` |

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

Die Tests laufen ohne Docker gegen die eingebettete Datenbank. Gegen ein echtes Postgres:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/events npx vitest run --no-file-parallelism
```

## Deployment

Die Schritt-für-Schritt-Anleitung für Coolify samt Testkauf und Live-Schaltung steht in [docs/deployment.md](docs/deployment.md).

Der Dienst braucht eine Postgres-Datenbank und kein eigenes Volume. Migrationen laufen beim Start automatisch.
