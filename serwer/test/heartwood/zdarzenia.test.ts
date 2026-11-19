import { describe, expect, it, vi } from 'vitest';
import { idZdarzenia, zwalidujZdarzenie, type Zdarzenie } from '@cognifly/wspolne';
import type { Task } from '@cognifly/wspolne/api';
import {
  handleHeartwoodEvent, plan, writerOfWork, type HwEvent, type Lookup,
} from '../../src/heartwood/zdarzenia.js';

const WORK = 'cognifly:zad_0123456789ab';
const TIME = '2026-11-19T10:00:00Z';
const GB = 1024 ** 3;

const ev = (type: string, detail: Record<string, unknown>, id = 'eb-1'): HwEvent => ({
  id, 'detail-type': type, source: 'heartwood', time: TIME, detail,
});
const lock = (p: Record<string, unknown> = {}) => ({
  org: 'pilot', ws: 'Wspólne', path: 'Oferty/a.docx', workId: WORK, by: 'sub-s', folder: false, ...p,
});
const rejected = (reason: string, p: Record<string, unknown> = {}) => ({
  org: 'pilot', space: 'Wspólne', path: 'Oferty/a.docx', by: 'sub-m', reason, ...p,
});
const quota = (p: Record<string, unknown> = {}) => ({
  org: 'pilot', usedBytes: 4.24 * GB, limitBytes: 5 * GB, ...p,
});

/** Fake lookup: subs sub-m/sub-s, writer michal of WORK. */
const lookup = (p: Partial<Lookup> = {}): Lookup => ({
  personOf: async (_f, sub) => ({ 'sub-m': 'michal', 'sub-s': 'szymon' } as Record<string, string>)[sub] ?? null,
  writerOf: async (_f, w) => (w === WORK ? 'michal' : null),
  admins: async () => ['admin1', 'admin2'],
  ...p,
});

describe('plan', () => {
  it.each([
    ['lock.release_requested', lock(), 'pliki.blokada.prosba', true, ['michal'],
      'Prośba o zwolnienie pliku Wspólne/Oferty/a.docx (od: szymon)'],
    ['change.rejected', rejected('conflict'), 'pliki.zmiana.konflikt', true, ['michal'],
      'Konflikt pliku Wspólne/Oferty/a.docx: przepisz swoje zmiany z kopii konfliktu'],
    ['change.rejected', rejected('no_lock'), 'pliki.zmiana.odrzucona', false, ['michal'],
      'Zmiana pliku Wspólne/Oferty/a.docx odrzucona (brak blokady)'],
    ['change.rejected', rejected('name'), 'pliki.zmiana.odrzucona', false, ['michal'],
      'Zmiana pliku Wspólne/Oferty/a.docx odrzucona (niedozwolona nazwa)'],
    ['change.rejected', rejected('excluded'), 'pliki.zmiana.odrzucona', false, ['michal'],
      'Zmiana pliku Wspólne/Oferty/a.docx odrzucona (plik wykluczony)'],
    ['change.rejected', rejected('quota'), 'pliki.zmiana.odrzucona', false, ['michal'],
      'Zmiana pliku Wspólne/Oferty/a.docx odrzucona (brak miejsca)'],
    ['lock.broken', lock({ reason: 'x' }), 'pliki.blokada.zdjeta', false, ['michal'],
      'Admin zdjął blokadę pliku Wspólne/Oferty/a.docx'],
    ['quota.near', quota({ sub: 'sub-s' }), 'pliki.limit.blisko', false, ['szymon'],
      'Miejsce na pliki: 4,2 GB z 5,0 GB (80%)'],
    ['quota.exceeded', quota({ sub: 'sub-s' }), 'pliki.limit.przekroczony', true, ['szymon'],
      'Miejsce na pliki: 4,2 GB z 5,0 GB — limit przekroczony'],
    ['quota.near', quota(), 'pliki.limit.blisko', false, ['admin1', 'admin2'],
      'Miejsce na pliki: 4,2 GB z 5,0 GB (80%)'],
    ['quota.exceeded', quota({ sub: 'sub-x' }), 'pliki.limit.przekroczony', true, ['admin1', 'admin2'],
      'Miejsce na pliki: 4,2 GB z 5,0 GB — limit przekroczony'],
  ] as const)('%s %j', async (type, detail, typ, task, recipients, opis) => {
    const r = await plan(ev(type, detail), lookup());
    expect(r).not.toBeNull();
    expect(r!.zdarzenie).toMatchObject({ typ, opis, zrodlo: 'pliki', firma: 'pilot', wymagaPracy: task, czas: TIME });
    expect(r!.task).toBe(task);
    expect(r!.recipients).toEqual(recipients);
    expect(zwalidujZdarzenie(r!.zdarzenie).ok).toBe(true);
  });

  it('derives the event id and subject from the bus event', async () => {
    const r = await plan(ev('lock.release_requested', lock(), 'eb-42'), lookup());
    expect(r!.zdarzenie.id).toBe(idZdarzenia('pliki', 'eb-42'));
    expect(r!.zdarzenie.podmiot).toEqual({ org: 'pilot', sciezka: 'Wspólne/Oferty/a.docx', workId: WORK });
  });

  it('release request without writer goes to admins', async () => {
    const r = await plan(ev('lock.release_requested', lock({ workId: 'cognifly:zad_aaaaaaaaaaaa' })), lookup());
    expect(r!.recipients).toEqual(['admin1', 'admin2']);
    expect(r!.task).toBe(true);
  });

  it('unknown requester is named as outsider', async () => {
    const r = await plan(ev('lock.release_requested', lock({ by: 'sub-x' })), lookup());
    expect(r!.zdarzenie.opis).toBe('Prośba o zwolnienie pliku Wspólne/Oferty/a.docx (od: ktoś spoza CogniFly)');
  });

  it('unknown author of a rejected change has no recipients', async () => {
    const r = await plan(ev('change.rejected', rejected('conflict', { by: 'sub-x' })), lookup());
    expect(r!.recipients).toEqual([]);
  });

  it('broken lock of work without writer has no recipients', async () => {
    const r = await plan(ev('lock.broken', lock({ workId: 'other:1' })), lookup());
    expect(r!.recipients).toEqual([]);
  });

  it('deduplicates admins', async () => {
    const r = await plan(ev('quota.near', quota()), lookup({ admins: async () => ['a', 'a', 'b'] }));
    expect(r!.recipients).toEqual(['a', 'b']);
  });

  it.each([
    ['file.deleted', { org: 'pilot', space: 's', path: 'p', seq: 1, author: 'x' }],
    ['lock.release_requested', lock({ path: 5 })],
    ['lock.release_requested', lock({ org: '' })],
    ['change.rejected', rejected('other')],
    ['quota.near', quota({ usedBytes: 'x' })],
    ['quota.near', quota({ sub: 7 })],
  ])('%s %j -> null', async (type, detail) => {
    expect(await plan(ev(type, detail as Record<string, unknown>), lookup())).toBeNull();
  });

  it('rejects a bad source or time', async () => {
    expect(await plan({ ...ev('lock.broken', lock()), source: 'x' as 'heartwood' }, lookup())).toBeNull();
    expect(await plan({ ...ev('lock.broken', lock()), time: 'wczoraj' }, lookup())).toBeNull();
  });

  it('shows ws:X as X and user:* as Prywatne in text and subject', async () => {
    const ws = await plan(ev('change.rejected', rejected('no_lock', { space: 'ws:wspolne' })), lookup());
    expect(ws!.zdarzenie.opis).toBe('Zmiana pliku wspolne/Oferty/a.docx odrzucona (brak blokady)');
    expect(ws!.zdarzenie.podmiot).toEqual({ org: 'pilot', sciezka: 'wspolne/Oferty/a.docx' });
    const own = await plan(ev('change.rejected', rejected('conflict', { space: 'user:sub-m' })), lookup());
    expect(own!.zdarzenie.opis).toBe('Konflikt pliku Prywatne/Oferty/a.docx: przepisz swoje zmiany z kopii konfliktu');
    expect(own!.zdarzenie.podmiot).toEqual({ org: 'pilot', sciezka: 'Prywatne/Oferty/a.docx' });
  });

  it('strips control and bidi characters from the shown path', async () => {
    const path = 'Oferty/a\u0007\u202Ecod.exe\u200B\n.docx';
    const r = await plan(ev('lock.broken', lock({ path })), lookup());
    expect(r!.zdarzenie.opis).toBe('Admin zdjął blokadę pliku Wspólne/Oferty/acod.exe.docx');
  });

  it('cuts the shown path by code points, not inside a surrogate pair', async () => {
    const path = '😀'.repeat(200);
    const r = await plan(ev('lock.broken', lock({ path })), lookup());
    const shown = r!.zdarzenie.opis.slice('Admin zdjął blokadę pliku '.length);
    expect(Array.from(shown)).toHaveLength(120);
    expect(shown).toBe(`Wspólne/${'😀'.repeat(111)}…`);
  });

  it('trims a long path to 120 chars and keeps opis within 300', async () => {
    const path = `${'a'.repeat(400)}.docx`;
    const r = await plan(ev('change.rejected', rejected('conflict', { path, space: 'b'.repeat(200) })), lookup());
    const opis = r!.zdarzenie.opis;
    const shown = opis.slice('Konflikt pliku '.length, opis.indexOf(': przepisz'));
    expect(shown).toHaveLength(120);
    expect(shown.endsWith('…')).toBe(true);
    expect(opis.length).toBeLessThanOrEqual(300);
  });
});

describe('writerOfWork', () => {
  const task = (p: Partial<Task>): Task => ({
    id: 'zad_0123456789ab', firma: 'pilot', zdarzenieId: 'z', kandydaci: [],
    stan: 'wziete', utworzono: TIME, opis: 'o', ...p,
  });

  it('reads the writer of a CogniFly task', async () => {
    const get = vi.fn(async () => task({ wlasciciel: 'michal' }));
    expect(await writerOfWork('pilot', WORK, get)).toBe('michal');
    expect(get).toHaveBeenCalledWith('pilot', 'zad_0123456789ab');
  });

  it('is null for foreign work ids, missing or new tasks', async () => {
    const get = vi.fn(async () => task({ wlasciciel: 'michal' }));
    expect(await writerOfWork('pilot', 'other:zad_0123456789ab', get)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(await writerOfWork('pilot', WORK, async () => null)).toBeNull();
    expect(await writerOfWork('pilot', WORK, async () => task({ stan: 'nowe' }))).toBeNull();
  });
});

describe('handleHeartwoodEvent', () => {
  const deps = (save: 'NOWE' | 'DUPLIKAT', p: Partial<Lookup> = {}) => ({
    ...lookup(p),
    save: vi.fn(async (_z: Zdarzenie) => save),
    createTask: vi.fn(async () => ({})),
    notify: vi.fn(async () => ({ wyslane: 1, bledy: [] as string[] })),
  });

  it('creates a task with id from the event id and does not notify', async () => {
    const d = deps('NOWE');
    await handleHeartwoodEvent(ev('change.rejected', rejected('conflict')), d);
    const z = d.save.mock.calls[0]![0];
    expect(z.wymagaPracy).toBe(true);
    expect(d.createTask).toHaveBeenCalledWith('pilot', z.id, ['michal'], {
      id: `zad_${z.id.slice('evt_'.length)}`,
      opis: 'Konflikt pliku Wspólne/Oferty/a.docx: przepisz swoje zmiany z kopii konfliktu',
    });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('notifies by email and discord', async () => {
    const d = deps('NOWE');
    await handleHeartwoodEvent(ev('lock.broken', lock()), d);
    expect(d.createTask).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(
      'pilot', expect.objectContaining({ typ: 'pliki.blokada.zdjeta' }),
      [{ osoba: 'michal', kanaly: ['email', 'discord'] }], 'nowe',
    );
  });

  it('duplicate does not notify but still completes the task', async () => {
    const n = deps('DUPLIKAT');
    await handleHeartwoodEvent(ev('lock.broken', lock()), n);
    expect(n.notify).not.toHaveBeenCalled();
    const t = deps('DUPLIKAT');
    await handleHeartwoodEvent(ev('quota.exceeded', quota()), t);
    expect(t.createTask).toHaveBeenCalledTimes(1);
  });

  it('zero recipients saves the event only', async () => {
    const d = deps('NOWE');
    await handleHeartwoodEvent(ev('change.rejected', rejected('conflict', { by: 'sub-x' })), d);
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.createTask).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('ignores events it cannot read', async () => {
    const d = deps('NOWE');
    await handleHeartwoodEvent(ev('lock.acquired', lock()), d);
    expect(d.save).not.toHaveBeenCalled();
  });

  it('a notification failure does not throw', async () => {
    const d = deps('NOWE');
    d.notify.mockRejectedValueOnce(new Error('smtp'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleHeartwoodEvent(ev('lock.broken', lock()), d)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
