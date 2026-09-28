# event-backend

Kleiner Dienst für den Verkauf von Seminaren und Workshops über die eigene Webseite.

- **Öffentliche API** für Event-Liste und Detailansicht auf der Webseite
- **MCP-Server** zum Anlegen und Verwalten der Events mit Claude
- Bezahlung über Stripe Checkout und Bestätigungs-Mails folgen in Phase 2

## Stand

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Grundgerüst, Datenbank, Lese-API, MCP-Tools für Events, Thumbnails und Einstellungen | fertig |
| 2 | Stripe Checkout, Webhooks, Platzreservierung, Mails an Käufer | offen |
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

`APP_SECRET` darf sich nach der Einrichtung nicht mehr ändern, sonst muss das SMTP-Passwort neu gesetzt werden.

## Öffentliche API

| Endpunkt | Zweck |
|---|---|
| `GET /v1/events` | Veröffentlichte, kommende Events. `?when=past` oder `?when=all` für vergangene |
| `GET /v1/events/:slug` | Ein Event mit Beschreibung (HTML) und Ticket-Typen |
| `GET /media/:hash/large.webp` | Thumbnail, maximal 1600 px breit |
| `GET /media/:hash/small.webp` | Thumbnail, maximal 640 px breit |
| `GET /healthz` | Health Check |

Entwürfe und archivierte Events sind nie sichtbar. Die Online-URL und Verkaufszahlen erscheinen nie in der öffentlichen API. Die Zahl freier Plätze (`remaining`) wird nur geliefert, wenn sie den Schwellenwert `low_stock_threshold` erreicht oder unterschreitet.

Preise sind Bruttobeträge in Cent (`49000` = 490,00 €).

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

## Deployment mit Coolify

1. In Coolify eine **PostgreSQL**-Ressource anlegen und geplante Backups auf einen S3-Speicher einrichten. Die Thumbnails liegen in der Datenbank, das Backup deckt also alles ab.
2. Eine **Application** aus dem GitHub-Repo anlegen, Build Pack `Dockerfile`, Port `3000`.
3. Domain eintragen, z. B. `https://events.example.de`.
4. Umgebungsvariablen setzen: `ADMIN_TOKEN`, `APP_SECRET`, `PUBLIC_BASE_URL`, `DATABASE_URL` (interne Postgres-URL aus Coolify).
5. Health Check auf `/healthz` stellen.

Die Datenbank-Migrationen laufen automatisch beim Start. Der Dienst braucht kein eigenes Volume.
