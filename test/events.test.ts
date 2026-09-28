import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addTicketType,
  createEvent,
  deleteEvent,
  duplicateEvent,
  getEvent,
  removeTicketType,
  seatsAvailable,
  setEventStatus,
  updateEvent,
  updateTicketType,
} from '../src/domain/events.ts';
import { createTestApp, daysFromNow, eventInput } from './helpers.ts';
import type { TestApp } from './helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

describe('creating events', () => {
  it('starts as draft with a slug derived from the title', async () => {
    const event = await createEvent(t.db, eventInput({ title: 'Führung & Ökonomie – Größe zählt' }));
    expect(event.status).toBe('draft');
    expect(event.slug).toBe('fuehrung-oekonomie-groesse-zaehlt');
    expect(event.ticket_types.map((ticket) => ticket.name)).toEqual(['Präsenz', 'Online']);
  });

  it('numbers slugs when the title repeats', async () => {
    const first = await createEvent(t.db, eventInput());
    const second = await createEvent(t.db, eventInput());
    const third = await createEvent(t.db, eventInput());
    expect([second.slug, third.slug]).toEqual([`${first.slug}-2`, `${first.slug}-3`]);
  });

  it('rejects a requested slug that is taken', async () => {
    await createEvent(t.db, eventInput({ slug: 'ki-seminar' }));
    await expect(createEvent(t.db, eventInput({ slug: 'ki-seminar' }))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(createEvent(t.db, eventInput({ slug: 'Not Valid' }))).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('rejects ticket types that do not fit the format', async () => {
    await expect(
      createEvent(
        t.db,
        eventInput({
          format: 'onsite',
          ticket_types: [{ name: 'Online', attendance: 'online', price_cents: 1000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects an end before the start', async () => {
    await expect(
      createEvent(t.db, eventInput({ starts_at: daysFromNow(5), ends_at: daysFromNow(4) })),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('updating events', () => {
  it('changes only the given fields and clears fields set to null', async () => {
    const event = await createEvent(t.db, eventInput());
    const updated = await updateEvent(t.db, event.slug, { title: 'Neuer Titel', online_url: null });
    expect(updated.title).toBe('Neuer Titel');
    expect(updated.online_url).toBeNull();
    expect(updated.slug).toBe(event.slug);
    expect(updated.location_name).toBe('Seminarhaus');
  });

  it('refuses a format that conflicts with existing ticket types', async () => {
    const event = await createEvent(t.db, eventInput());
    await expect(updateEvent(t.db, event.id, { format: 'online' })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('validates the time range against the stored value', async () => {
    const event = await createEvent(t.db, eventInput());
    await expect(updateEvent(t.db, event.id, { ends_at: daysFromNow(1) })).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('status changes', () => {
  it('publishes an event and reports what is missing', async () => {
    const event = await createEvent(t.db, eventInput({ online_url: null }));
    const result = await setEventStatus(t.db, event.id, 'published');
    expect(result.event.status).toBe('published');
    expect(result.warnings.join(' ')).toContain('No online URL');
    expect(result.warnings.join(' ')).toContain('no thumbnail');
  });

  it('does not publish without ticket types', async () => {
    const event = await createEvent(t.db, eventInput({ ticket_types: [] }));
    await expect(setEventStatus(t.db, event.id, 'published')).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('does not publish an event that is over', async () => {
    const event = await createEvent(
      t.db,
      eventInput({ starts_at: daysFromNow(-3), ends_at: daysFromNow(-2) }),
    );
    await expect(setEventStatus(t.db, event.id, 'published')).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('rejects transitions that make no sense', async () => {
    const event = await createEvent(t.db, eventInput());
    await expect(setEventStatus(t.db, event.id, 'cancelled')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('warns about sold tickets when cancelling', async () => {
    const event = await createEvent(t.db, eventInput());
    await setEventStatus(t.db, event.id, 'published');
    await t.addOrder({
      event_id: event.id,
      ticket_type_id: event.ticket_types[0]!.id,
      quantity: 3,
      status: 'paid',
    });
    const result = await setEventStatus(t.db, event.id, 'cancelled');
    expect(result.warnings[0]).toContain('3 tickets');
  });
});

describe('seat availability', () => {
  it('counts paid orders and open reservations, nothing else', async () => {
    const event = await createEvent(t.db, eventInput());
    const onsite = event.ticket_types[0]!;
    const order = { event_id: event.id, ticket_type_id: onsite.id };
    await t.addOrder({ ...order, quantity: 4, status: 'paid' });
    await t.addOrder({ ...order, quantity: 2, status: 'pending', expires_at: daysFromNow(0, 1) });
    await t.addOrder({ ...order, quantity: 5, status: 'pending', expires_at: daysFromNow(0, -1) });
    await t.addOrder({ ...order, quantity: 7, status: 'expired' });
    await t.addOrder({ ...order, quantity: 1, status: 'refunded' });

    const [ticket, online] = (await getEvent(t.db, event.id)).ticket_types;
    expect(ticket).toMatchObject({ sold: 4, reserved: 2 });
    expect(seatsAvailable(ticket!)).toBe(14);
    expect(seatsAvailable(online!)).toBeNull();
  });
});

describe('ticket types', () => {
  it('cannot shrink below the seats already taken', async () => {
    const event = await createEvent(t.db, eventInput());
    const onsite = event.ticket_types[0]!;
    await t.addOrder({ event_id: event.id, ticket_type_id: onsite.id, quantity: 6, status: 'paid' });

    await expect(updateTicketType(t.db, onsite.id, { capacity: 5 })).rejects.toMatchObject({
      code: 'conflict',
    });
    const updated = await updateTicketType(t.db, onsite.id, { capacity: 6, price_cents: 51000 });
    expect(updated.ticket_types[0]).toMatchObject({ capacity: 6, price_cents: 51000 });
  });

  it('can be added and removed while there are no orders', async () => {
    const event = await createEvent(t.db, eventInput());
    const added = await addTicketType(t.db, event.id, {
      name: 'Frühbucher',
      attendance: 'onsite',
      price_cents: 39000,
      capacity: 5,
      sales_end: daysFromNow(10),
    });
    expect(added.ticket_types).toHaveLength(3);

    const early = added.ticket_types.find((ticket) => ticket.name === 'Frühbucher')!;
    await t.addOrder({ event_id: event.id, ticket_type_id: early.id, quantity: 1, status: 'expired' });
    await expect(removeTicketType(t.db, early.id)).rejects.toMatchObject({ code: 'conflict' });

    const remaining = await removeTicketType(t.db, event.ticket_types[1]!.id);
    expect(remaining.ticket_types.map((ticket) => ticket.name)).toEqual(['Präsenz', 'Frühbucher']);
  });

  it('reports unknown ticket types', async () => {
    await expect(removeTicketType(t.db, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('duplicating and deleting', () => {
  it('copies an event into a new draft', async () => {
    const event = await createEvent(t.db, eventInput());
    await setEventStatus(t.db, event.id, 'published');
    const copy = await duplicateEvent(t.db, event.id, {
      starts_at: daysFromNow(90),
      ends_at: daysFromNow(90, 8),
    });
    expect(copy.id).not.toBe(event.id);
    expect(copy.status).toBe('draft');
    expect(copy.slug).toBe(`${event.slug}-2`);
    expect(copy.ticket_types.map((ticket) => [ticket.name, ticket.capacity])).toEqual([
      ['Präsenz', 20],
      ['Online', null],
    ]);
  });

  it('deletes drafts only', async () => {
    const draft = await createEvent(t.db, eventInput());
    const live = await createEvent(t.db, eventInput());
    await setEventStatus(t.db, live.id, 'published');

    await expect(deleteEvent(t.db, live.id)).rejects.toMatchObject({ code: 'conflict' });
    await deleteEvent(t.db, draft.id);
    await expect(getEvent(t.db, draft.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
