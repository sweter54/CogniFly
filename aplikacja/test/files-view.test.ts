import type { Task } from '@cognifly/wspolne/api';
import { describe, expect, it } from 'vitest';
import {
  canLockFiles, fileErrorText, filesViewModel, parseTopics, spaceStatusText, versionLine,
} from '../src/logic/files-view.js';
import { DISABLED_INFO, filesView, parseStatus, type HwInfo, type HwState, type HwVersion } from '../src/logic/heartwood.js';
import { RpcError } from '../src/logic/rpc.js';
import { STATUS_REPLY } from './helpers.js';

const info = (state: HwState): HwInfo => ({ state, root: '/Users/a/Heartwood', restarts: 0, lastError: null });
const running = (status: unknown = STATUS_REPLY) => filesView(info('running'), parseStatus(status));

describe('filesViewModel', () => {
  it('shows the D10 banner when files are disabled', () => {
    const m = filesViewModel(filesView(DISABLED_INFO, null));
    expect(m.banner).toBe('Pliki nie są jeszcze włączone w tej wersji CogniFly.');
    expect(m.ready).toBe(false);
    expect(m.spaces).toEqual([]);
  });

  it.each([
    ['not_installed', 'Heartwood nie jest zainstalowany na tym komputerze.'],
    ['restarting', 'Heartwood nie działa — uruchamiam ponownie…'],
  ] as const)('shows a banner for %s', (state, text) => {
    expect(filesViewModel(filesView(info(state), null)).banner).toBe(text);
  });

  it('says the daemon does not answer when running without status', () => {
    expect(filesViewModel(filesView(info('running'), null)).banner).toBe('Heartwood nie odpowiada.');
  });

  it('has no banner while starting or when connected', () => {
    expect(filesViewModel(filesView(info('starting'), null)).banner).toBeNull();
    expect(filesViewModel(running()).banner).toBeNull();
  });

  it('shows the offline banner when the daemon is not connected', () => {
    const m = filesViewModel(running({ ...STATUS_REPLY, connected: false }));
    expect(m.banner).toBe('Brak połączenia z serwerem plików — zmiany czekają.');
    expect(m.ready).toBe(true);
  });

  it('marks a space behind the server as not synced', () => {
    const m = filesViewModel(running());
    expect(m.spaces).toEqual([
      { label: 'ws:w1', folder: 'wspolne', synced: false, unsent: 3 },
      { label: 'prv:michal', folder: 'Prywatne', synced: true, unsent: 4 },
    ]);
  });

  it('passes conflicts, skipped files and issues with their fields', () => {
    const m = filesViewModel(running());
    expect(m.conflicts[0]).toEqual({
      space: 'ws:w1', path: 'b.docx', copyPath: 'b (konflikt).docx', at: '2026-11-19T10:00:00Z', message: 'Ktoś zmienił plik.',
    });
    expect(m.skipped[0]).toEqual({
      space: 'ws:w1', path: 'x:y', reason: 'name:NAME_INVALID', reasonText: 'nieprawidłowa nazwa', suggestion: 'x_y', hint: 'zmień nazwę na „x_y”',
    });
    expect(m.skipped[1]).toMatchObject({ path: 'big.iso', reasonText: 'za duży' });
    expect(m.issues).toEqual([{ space: '', message: 'Brak połączenia z serwerem.' }]);
  });
});

describe('spaceStatusText', () => {
  it.each([
    [{ synced: true, unsent: 0 }, 'Zsynchronizowane'],
    [{ synced: true, unsent: 2 }, 'Wysyłanie: 2'],
    [{ synced: false, unsent: 3 }, 'Wysyłanie: 3'],
    [{ synced: false, unsent: 0 }, 'Pobieranie zmian…'],
  ])('%j → %s', (row, text) => expect(spaceStatusText({ label: 's', folder: 'f', ...row })).toBe(text));
});

describe('parseTopics', () => {
  it('splits by comma and drops blanks', () => expect(parseTopics(' Dokumenty, ,Umowy ,')).toEqual(['Dokumenty', 'Umowy']));
  it('gives undefined for no topics', () => expect(parseTopics('  , ')).toBeUndefined());
});

describe('versionLine', () => {
  it('shows number, date, author and kind', () => {
    const v: HwVersion = { seq: 4, versionId: 'v', sha256: 'h', size: 1, author: 'michal', at: '2026-11-19T10:00:00Z', kind: 'restore' };
    const line = versionLine(v);
    expect(line).toMatch(/^Wersja 4 · .+ · michal · przywrócenie$/);
    expect(line).toContain('2026');
  });
});

describe('fileErrorText', () => {
  it('uses the daemon text for a refusal', () => expect(fileErrorText(new RpcError('LOCKED', 'Plik jest zablokowany.'))).toBe('Plik jest zablokowany.'));
  it('uses app texts for app codes', () => expect(fileErrorText(new RpcError('TIMEOUT'))).toBe('Heartwood nie odpowiada.'));
  it('explains a path outside the root', () => expect(fileErrorText(new RpcError('OUTSIDE'))).toBe('Można wybrać tylko pliki z folderu Heartwood.'));
  it('names unknown errors', () => expect(fileErrorText(new Error('x'))).toBe('Nie udało się (UNEXPECTED).'));
});

describe('canLockFiles', () => {
  const task = (stan: Task['stan'], extra: Partial<Task> = {}): Task => ({
    id: 'zad_000000000001', firma: 'pilot', zdarzenieId: 'e', kandydaci: [], stan, utworzono: '', opis: 'x', wlasciciel: 'anna', ...extra,
  });

  it.each(['wziete', 'w_trakcie'] as const)('allows the owner in %s', (stan) => expect(canLockFiles(task(stan), 'anna', 'running')).toBe(true));

  it('allows the acceptor of a task waiting for acceptance', () => {
    expect(canLockFiles(task('do_akceptacji', { akceptujacy: 'jan' }), 'jan', 'running')).toBe(true);
    expect(canLockFiles(task('do_akceptacji', { akceptujacy: 'jan' }), 'anna', 'running')).toBe(false);
  });

  it('refuses others, other states and unusable files', () => {
    expect(canLockFiles(task('w_trakcie'), 'jan', 'running')).toBe(false);
    expect(canLockFiles(task('nowe'), 'anna', 'running')).toBe(false);
    expect(canLockFiles(task('w_trakcie'), null, 'running')).toBe(false);
    expect(canLockFiles(task('w_trakcie'), 'anna', 'disabled')).toBe(false);
    expect(canLockFiles(task('w_trakcie'), 'anna', 'not_installed')).toBe(false);
  });
});
