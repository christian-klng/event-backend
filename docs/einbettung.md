# Einbettung in die Webseite

Das Skript `embed.js` bringt drei HTML-Elemente mit. Es hat keine Abhängigkeiten und rendert direkt in die Seite, das CSS der Webseite greift also ganz normal.

## Schnellstart

Seite mit der Event-Liste:

```html
<script src="https://events.ai-up.club/embed.js" defer></script>

<event-list></event-list>
```

Danke-Seite (die Adresse aus `checkout_success_url`):

```html
<script src="https://events.ai-up.club/embed.js" defer></script>

<event-order-status></event-order-status>
```

Eine Vorschau ohne eigenes Styling liegt unter `https://events.ai-up.club/demo`.

## Elemente

### `<event-list>`

Zeigt die veröffentlichten Events als Karten. Ein Klick öffnet die Details mit Ticket-Auswahl in einem Modal.

| Attribut | Werte | Standard |
|---|---|---|
| `when` | `upcoming`, `past`, `all` | `upcoming` |
| `format` | `online`, `onsite` (Hybrid-Events erscheinen bei beiden) | alle |
| `limit` | Höchstzahl der Events | alle |
| `empty-text` | Text, wenn es keine Events gibt | „Aktuell sind keine Veranstaltungen geplant." |
| `heading-level` | Überschriften-Ebene der Event-Titel, `1` bis `6` | `3` |

Jedes Event hat eine eigene Adresse: `…/seminare#event/<slug>` öffnet das Modal direkt. Solche Links eignen sich für Newsletter und Social Media.

### `<event-detail>`

Zeigt ein einzelnes Event direkt in der Seite, ohne Modal.

```html
<event-detail slug="ki-fuer-fuehrungskraefte"></event-detail>
```

Ohne `slug` liest das Element den Wert aus der Adresse der Seite (`?event=<slug>`).

### `<event-order-status>`

Zeigt auf der Danke-Seite das Ergebnis des Kaufs. Stripe hängt `?session_id=…` an die Adresse, das Element liest den Wert selbst aus. Die Zahlungsbestätigung trifft meist nach wenigen Sekunden ein, bis dahin fragt das Element alle zwei Sekunden nach.

## Aussehen anpassen

Die mitgelieferten Styles haben keine Spezifität. Jede Regel der Webseite gewinnt, auch ein einfacher Klassen-Selektor ohne `!important`.

### Farben und Abstände

```css
event-list,
event-detail,
event-order-status,
.ev-dialog {
  --ev-accent: #e11d48; /* Buttons, Datum, Links */
  --ev-accent-text: #fff; /* Schrift auf Buttons */
  --ev-radius: 4px; /* Eckenradius */
  --ev-gap: 2rem; /* Abstand zwischen Karten */
  --ev-border: #ddd; /* Rahmenfarbe */
  --ev-muted: #666; /* Nebentexte */
}
```

Schrift und Textfarbe übernimmt das Skript von der Webseite.

### Klassen

| Bereich | Klassen |
|---|---|
| Liste | `.ev-list`, `.ev-card`, `.ev-card__image`, `.ev-card__date`, `.ev-card__title`, `.ev-card__summary`, `.ev-card__price`, `.ev-card__note` |
| Angaben | `.ev-meta`, `.ev-badge`, `.ev-badge--online`, `.ev-badge--onsite`, `.ev-badge--hybrid` |
| Modal | `.ev-dialog`, `.ev-dialog__close`, `.ev-dialog::backdrop` |
| Details | `.ev-detail`, `.ev-detail__image`, `.ev-detail__date`, `.ev-detail__title`, `.ev-detail__description` |
| Tickets | `.ev-tickets`, `.ev-ticket`, `.ev-ticket__name`, `.ev-ticket__price`, `.ev-ticket__hint`, `.ev-ticket__error`, `.ev-button` |
| Danke-Seite | `.ev-status`, `.ev-status--paid`, `.ev-status--failed`, `.ev-status__title` |
| Meldungen | `.ev-message`, `.ev-message--error` |

Karten und Tickets tragen zusätzlich Daten-Attribute, etwa `data-format="online"`, `data-status="cancelled"` oder `data-on-sale="false"`.

### Ganz eigenes Styling

```html
<script src="https://events.ai-up.club/embed.js" data-styles="off" defer></script>
```

Damit lädt das Skript keine eigenen Styles.

## Texte ändern

Vor dem Skript festlegen:

```html
<script>
  window.eventWidgetConfig = {
    texts: {
      buy: 'Platz sichern',
      soldOut: 'Leider ausgebucht',
    },
  };
</script>
<script src="https://events.ai-up.club/embed.js" defer></script>
```

Alle Schlüssel stehen am Anfang von `public/embed.js` im Objekt `TEXTS`.

## Ereignisse

| Ereignis | Wann | `detail` |
|---|---|---|
| `event-list-loaded` | Liste geladen | `{ events }` |
| `event-checkout` | Kauf gestartet, kurz vor der Weiterleitung zu Stripe | `{ ticket, checkout }` |
| `event-order-paid` | Danke-Seite hat die Zahlung bestätigt | `{ order }` |

```js
document.addEventListener('event-order-paid', (event) => {
  // z. B. Conversion an die Webanalyse melden
});
```

## Voraussetzungen

- Die Webseite muss in `allowed_origins` stehen, sobald diese Einstellung gesetzt ist. Bei leerer Liste darf jede Webseite die API aufrufen.
- Hat die Webseite eine Content Security Policy, braucht sie `script-src` und `connect-src` für `https://events.ai-up.club` sowie `img-src` für die Thumbnails.
- Browser speichern das Skript fünf Minuten lang. Änderungen am Skript erscheinen also mit kurzer Verzögerung.
