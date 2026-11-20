import type { Task } from '@cognifly/wspolne/api';
import { describe, expect, it } from 'vitest';
import { attentionEntries, attentionQueue, MAX_ATTENTION_ITEMS, menuText, type AttentionItem } from '../src/logic/attention.js';
import { conflictKey } from '../src/logic/files-view.js';
import { DISABLED_INFO, filesView, parseStatus, type HwInfo } from '../src/logic/heartwood.js';
import type { InboxView } from '../src/windows/protocol.js';
import { STATUS_REPLY } from './helpers.js';

const task = (n: number, stan: Task['stan'] = 'nowe', opis = `Zadanie ${n}`): Task => ({
  id: `zad_${String(n).padStart(12, '0')}`, firma: 'pilot', zdarzenieId: 'e', kandydaci: [], stan, utworzono: '', opis,
});
const running: HwInfo = { state: 'running', root: '/Users/a/Heartwood', restarts: 0, lastError: null };

/** A logged-in view; `status` is a daemon `status` reply or `null`. */
function view(over: Partial<InboxView> = {}, status: unknown = null, info: HwInfo = running): InboxView {
  return {
    loggedIn: true, offline: false, email: 'a@b.pl', osoba: 'os_1', tasks: [], updatedAt: null, workFolder: '/w', blocked: null,
    files: filesView(info, status === null ? null : parseStatus(status)), ...over,
  };
}

const keys = (items: AttentionItem[]) => items.map((i) => i.key);

describe('attentionQueue', () => {
  it('is empty when logged out or when nothing waits', () => {
    expect(attentionQueue(view({ loggedIn: false, offline: true, tasks: [task(1)] }))).toEqual([]);
    expect(attentionQueue(view({}, null, DISABLED_INFO))).toEqual([]);
  });

  it('orders offline, conflicts, unsent spaces, tasks, then the error', () => {
    const items = attentionQueue(view({ offline: true, tasks: [task(1), task(2, 'zrobione')] }, STATUS_REPLY, { ...running, lastError: 'ROOT_TOO_LONG' }));
    expect(keys(items)).toEqual([
      'offline', `conflict:${conflictKey('ws:w1', 'b.docx')}`, `conflict:${conflictKey('ws:w1', 'c.docx')}`, 'unsent:ws:w1', 'unsent:prv:michal',
      `task:${task(1).id}`, 'hw-error',
    ]);
    expect(items[0]).toEqual({ key: 'offline', text: 'Brak połączenia z serwerem — kliknij, aby odświeżyć', action: { kind: 'refresh' } });
  });

  it('blocked_is_first_in_queue', () => {
    const reason = 'Brak dostępu do CogniFly: licencja firmy na CogniFly wygasła.';
    const items = attentionQueue(view({ blocked: reason, offline: true, tasks: [task(1)] }, STATUS_REPLY));
    expect(items[0]).toEqual({ key: 'blocked', text: reason, action: { kind: 'refresh' } });
    expect(keys(items)[1]).toBe('offline');
    expect(attentionQueue(view({ loggedIn: false, blocked: reason }))).toEqual([]);
  });

  it('shows one offline item also when only the file server is offline', () => {
    const items = attentionQueue(view({ offline: true }, { ...STATUS_REPLY, connected: false, conflicts: [], spaces: [] }));
    expect(keys(items)).toEqual(['offline']);
    expect(keys(attentionQueue(view({}, { ...STATUS_REPLY, connected: false, conflicts: [], spaces: [] })))).toEqual(['offline']);
  });

  it('links a conflict to the files screen with the conflict highlighted', () => {
    const [item] = attentionQueue(view({}, STATUS_REPLY));
    expect(item).toEqual({
      key: `conflict:${conflictKey('ws:w1', 'b.docx')}`, text: '⚠ Konflikt: w1/b.docx',
      action: { kind: 'screen', screen: 'files', highlight: conflictKey('ws:w1', 'b.docx') },
    });
  });

  it('shortens a long conflict path from the start', () => {
    const status = { ...STATUS_REPLY, conflicts: [{ ...STATUS_REPLY.conflicts[0], path: 'Klienci/2026/Oferty/Bardzo długi katalog/umowa.docx' }] };
    const [item] = attentionQueue(view({}, status));
    expect(item!.text).toBe('⚠ Konflikt: …/Oferty/Bardzo długi katalog/umowa.docx');
  });

  it('names spaces with unsent files and their counts', () => {
    const texts = attentionQueue(view({}, { ...STATUS_REPLY, conflicts: [] })).map((i) => i.text);
    expect(texts).toEqual(['↑ Do wysłania: w1 (3)', '↑ Do wysłania: prv:michal (4)']);
  });

  it('links a waiting task to the inbox, title on one shortened line', () => {
    const long = `Przygotuj\nofertę ${'x'.repeat(80)}`;
    const [item] = attentionQueue(view({ tasks: [task(7, 'eskalowane', long)] }));
    expect(item!.action).toEqual({ kind: 'screen', screen: 'inbox', highlight: task(7).id });
    expect(item!.text.startsWith('📥 Przygotuj ofertę x')).toBe(true);
    expect(item!.text.endsWith('…')).toBe(true);
    expect(Array.from(item!.text).length).toBeLessThanOrEqual(52);
  });

  it('spells out a Heartwood error code and keeps daemon text', () => {
    expect(attentionQueue(view({}, null, { ...running, lastError: 'NOT_RUNNING' }))[0]!.text).toMatch(/^Pliki: Heartwood/);
    expect(attentionQueue(view({}, null, { ...running, lastError: 'exit status: 1' }))[0]).toEqual({
      key: 'hw-error', text: 'Pliki: exit status: 1', action: { kind: 'screen', screen: 'files' },
    });
  });

  it('moves items up once higher ones are resolved', () => {
    const before = keys(attentionQueue(view({ tasks: [task(1)] }, STATUS_REPLY)));
    const after = keys(attentionQueue(view({ tasks: [task(1)] }, { ...STATUS_REPLY, conflicts: [] })));
    expect(before[0]).toMatch(/^conflict:/);
    expect(after[0]).toBe('unsent:ws:w1');
  });
});

describe('attentionEntries', () => {
  const item = (n: number): AttentionItem => ({ key: `k${n}`, text: `Sprawa ${n}`, action: { kind: 'refresh' } });

  it('shows a disabled line for an empty queue', () => {
    expect(attentionEntries([], true)).toEqual([{ text: 'Wszystko załatwione', enabled: false, action: null }]);
    expect(attentionEntries([], false)).toEqual([{ text: 'Zaloguj się, aby zobaczyć sprawy', enabled: false, action: null }]);
  });

  it('shows up to five items without a "more" line', () => {
    const entries = attentionEntries([1, 2, 3, 4, 5].map(item), true);
    expect(entries.map((e) => e.text)).toEqual(['Sprawa 1', 'Sprawa 2', 'Sprawa 3', 'Sprawa 4', 'Sprawa 5']);
  });

  it('cuts to five and adds "…i jeszcze N" that opens the main window', () => {
    const entries = attentionEntries([1, 2, 3, 4, 5, 6, 7, 8].map(item), true);
    expect(entries).toHaveLength(MAX_ATTENTION_ITEMS + 1);
    expect(entries.at(-1)).toEqual({ text: '…i jeszcze 3', enabled: true, action: { kind: 'main' } });
  });

  it('escapes & for the native menu', () => {
    expect(attentionEntries([{ ...item(1), text: 'A & B' }], true)[0]!.text).toBe('A && B');
    expect(menuText('a&&b&')).toBe('a&&&&b&&');
  });
});
