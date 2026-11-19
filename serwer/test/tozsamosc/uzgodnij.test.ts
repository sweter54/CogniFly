import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { activeSubs, rejestrOsob, tozsamosc, zapiszOsobe, zapiszTozsamosc } from '../../src/dane/konfiguracja.js';
import { reconcile, runReconcile } from '../../src/tozsamosc/uzgodnij.js';
import { IdentityError, type IdentityClient, type IdentityPerson } from '../../src/tozsamosc/klient.js';

const tabela = ustawTabeleTestowa('cognifly-test-uzgodnij');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());

const NOW = '2026-11-19T12:00:00.000Z';
const p = (sub: string, email: string, role: IdentityPerson['role'] = 'member', status: IdentityPerson['status'] = 'active'): IdentityPerson =>
  ({ sub, email, role, status });

/** Fake client: people per org; a value of Error makes `people` throw it. */
const fake = (orgs: Record<string, IdentityPerson[] | Error>): IdentityClient => ({
  orgs: async () => Object.keys(orgs),
  people: async (org) => {
    const v = orgs[org];
    if (v instanceof Error) throw v;
    return v ?? [];
  },
});

describe('reconcile', () => {
  it('reconcile_adds_new_sub_and_removes_unknown', async () => {
    const f = 'u-a';
    await zapiszOsobe(f, 'michal', { email: 'Michal@x.pl', rola: 'admin', sub: 'stary' });
    await zapiszTozsamosc('stary', f, 'michal');
    await zapiszOsobe(f, 'obcy', { email: 'obcy@x.pl', rola: 'czlonek', sub: 's-obcy' });
    await zapiszTozsamosc('s-obcy', f, 'obcy');
    const log = vi.fn();
    const r = await reconcile({
      client: fake({ [f]: [p('nowy', 'michal@x.pl', 'admin'), p('s-jan', 'jan@x.pl')] }), now: () => NOW, log,
    });
    expect(r).toEqual({ orgs: 1, added: 1, updated: 1, removed: 1, failed: [] });
    expect(await activeSubs(f)).toEqual(['nowy', 's-jan']);
    expect((await rejestrOsob(f)).map((o) => o.osoba)).toEqual(['jan', 'michal']);
    expect(await tozsamosc('nowy')).toEqual({ [f]: 'michal' });
    expect(await tozsamosc('s-obcy')).toEqual({});
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/@x\.pl/);
  });

  it('michal_sub_swap_removes_nobody', async () => {
    const f = 'u-b';
    await zapiszOsobe(f, 'michal', { email: 'michal@x.pl', rola: 'admin', sub: 'stary' });
    const r = await reconcile({ client: fake({ [f]: [p('nowy', 'michal@x.pl', 'admin')] }), now: () => NOW, log: vi.fn() });
    expect(r).toMatchObject({ updated: 1, removed: 0 });
    expect(await activeSubs(f)).toEqual(['nowy']);
  });

  it('reconcile_aborts_org_on_identity_error', async () => {
    const bad = 'u-c';
    const good = 'u-d';
    await zapiszOsobe(bad, 'ola', { email: 'ola@x.pl', rola: 'admin', sub: 's-ola' });
    const log = vi.fn();
    const client = fake({ [bad]: new IdentityError(500), [good]: [p('s-ewa', 'ewa@x.pl')] });
    const r = await reconcile({ client, now: () => NOW, log });
    expect(r).toEqual({ orgs: 2, added: 1, updated: 0, removed: 0, failed: [bad] });
    expect(await activeSubs(bad)).toEqual(['s-ola']);
    expect(await activeSubs(good)).toEqual(['s-ewa']);
    await expect(runReconcile({ client, now: () => NOW, log })).rejects.toThrow(bad);
  });

  it('orgs_error_fails_the_run', async () => {
    const client: IdentityClient = { orgs: async () => { throw new IdentityError(403); }, people: async () => [] };
    await expect(runReconcile({ client, now: () => NOW, log: vi.fn() })).rejects.toBeInstanceOf(IdentityError);
  });

  it('removed_status_in_identity_removes_person', async () => {
    const f = 'u-e';
    await zapiszOsobe(f, 'ala', { email: 'ala@x.pl', rola: 'czlonek', sub: 's-ala' });
    await zapiszOsobe(f, 'bob', { email: 'bob@x.pl', rola: 'czlonek', sub: 's-bob' });
    const client = fake({ [f]: [p('s-ala', 'ala@x.pl', 'member', 'removed'), p('s-bob', 'bob@x.pl', 'admin')] });
    const r = await reconcile({ client, now: () => NOW, log: vi.fn() });
    expect(r).toEqual({ orgs: 1, added: 0, updated: 1, removed: 1, failed: [] });
    expect(await rejestrOsob(f)).toEqual([{ osoba: 'bob', email: 'bob@x.pl', rola: 'admin', sub: 's-bob' }]);
  });
});
