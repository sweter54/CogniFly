import type { Task } from '@cognifly/wspolne/api';
import { describe, expect, it } from 'vitest';
import {
  canLockFiles, fileErrorText, filesViewModel, parseTopics, spaceStatusText, taskFilesModel, treeViewModel, versionLine,
} from '../src/logic/files-view.js';
import {
  DISABLED_INFO, filesView, parseStatus, type HwBrowse, type HwBrowseEntry, type HwInfo, type HwState, type HwVersion, type HwWorkFiles,
  type HwWorkLock, type HwWorkVersion,
} from '../src/logic/heartwood.js';
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

const AT = '2026-11-19T10:00:00Z';
const lock = (path: string, folder = false): HwWorkLock => ({
  space: 'ws:w1', path, folder, by: 'u1', at: AT, workId: 'cognifly:zad_0123456789ab', writer: 'u1', localPath: null,
});
const ver = (path: string, seq: number, kind: HwWorkVersion['kind'] = 'put', extra: Partial<HwWorkVersion> = {}): HwWorkVersion => ({
  space: 'ws:w1', path, seq, author: 'u1', at: AT, kind, localPath: null, ...extra,
});
const work = (extra: Partial<HwWorkFiles> = {}): HwWorkFiles => ({
  writer: 'u1', closed: false, locks: [], hiddenLocks: 0, versions: [], ...extra,
});

describe('taskFilesModel', () => {
  it('empty work is not an error', () => {
    const m = taskFilesModel(work({ writer: null }), 'u1');
    expect(m).toEqual({ canEdit: false, locks: [], changes: [], hiddenNote: null, closed: false });
    expect(taskFilesModel(work(), 'u1')).toMatchObject({ canEdit: true, locks: [], changes: [] });
    expect(taskFilesModel(null, 'u1')).toEqual({ canEdit: false, locks: [], changes: [], hiddenNote: null, closed: false });
  });

  it('only the writer gets actions', () => {
    expect(taskFilesModel(work({ writer: 'u2' }), 'u1').canEdit).toBe(false);
    expect(taskFilesModel(work(), null).canEdit).toBe(false);
    expect(taskFilesModel(work({ closed: true }), 'u1')).toMatchObject({ canEdit: false, closed: true });
    expect(taskFilesModel(work(), 'u1').canEdit).toBe(true);
  });

  it('labels locks with the workspace and marks folders', () => {
    const m = taskFilesModel(work({ locks: [lock('Oferty/a.docx'), lock('Oferty', true)] }), 'u1');
    expect(m.locks.map((r) => r.label)).toEqual(['w1/Oferty/a.docx', 'w1/Oferty/ (folder)']);
    expect(m.locks[0]).toMatchObject({ who: 'u1', space: 'ws:w1', path: 'Oferty/a.docx' });
    expect(m.locks[0]!.when).not.toBe('');
  });

  it('groups versions per file', () => {
    const versions = [ver('b.txt', 40), ...Array.from({ length: 30 }, (_, i) => ver('a.txt', 30 - i))];
    const m = taskFilesModel(work({ versions }), 'u1');
    expect(m.changes).toHaveLength(2);
    expect(m.changes[1]).toMatchObject({ label: 'w1/a.txt', latestSeq: 30, count: 30, kindText: 'zmiana', path: 'a.txt' });
    expect(m.changes[1]!.versions[0]!.seq).toBe(30);
    expect(m.changes[0]).toMatchObject({ label: 'w1/b.txt', count: 1 });
  });

  it('keeps the same path in two spaces apart and puts the newest on top', () => {
    const m = taskFilesModel(work({ versions: [ver('a.txt', 2), ver('a.txt', 5, 'put', { space: 'ws:w2' }), ver('a.txt', 3)] }), 'u1');
    expect(m.changes.map((c) => [c.label, c.latestSeq, c.count])).toEqual([['w1/a.txt', 3, 2], ['w2/a.txt', 5, 1]]);
  });

  it.each([
    ['put', {}, 'zmiana'],
    ['restore', {}, 'przywrócenie'],
    ['move', { fromPath: 'stary.txt' }, 'przeniesienie z stary.txt'],
    ['delete', {}, 'usunięcie'],
  ] as const)('names the newest kind %s', (kind, extra, text) => {
    const m = taskFilesModel(work({ versions: [ver('a.txt', 9, kind, extra), ver('a.txt', 1)] }), 'u1');
    expect(m.changes[0]!.kindText).toBe(text);
  });

  it('labels private versions as Prywatne', () => {
    const m = taskFilesModel(work({ versions: [ver('a.txt', 1, 'put', { space: 'user:u1' })] }), 'u1');
    expect(m.changes[0]!.label).toBe('Prywatne/a.txt');
  });

  it.each([
    [0, null],
    [1, '1 blokada w tematach, do których nie masz dostępu'],
    [3, '3 blokady w tematach, do których nie masz dostępu'],
    [5, '5 blokad w tematach, do których nie masz dostępu'],
    [12, '12 blokad w tematach, do których nie masz dostępu'],
    [22, '22 blokady w tematach, do których nie masz dostępu'],
  ])('notes %i hidden locks', (n, note) => {
    expect(taskFilesModel(work({ hiddenLocks: n }), 'u1').hiddenNote).toBe(note);
  });
});

const entry = (path: string, state: HwBrowseEntry['state'], extra: Partial<HwBrowseEntry> = {}): HwBrowseEntry => ({
  path, localPath: `/R/pilot/w1/${path}`, folder: false, state, ...extra,
});
const browse = (entries: HwBrowseEntry[], extra: Partial<HwBrowse> = {}): HwBrowse => ({
  space: 'ws:w1', folder: 'T', selected: true, entries, ...extra,
});
const TASKS = [{ id: 'zad_0123456789ab', workId: 'cognifly:zad_0123456789ab', title: 'Oferta' }];

describe('treeViewModel', () => {
  it('names rows and their states', () => {
    const m = treeViewModel(browse([
      entry('T/a.txt', 'free'), entry('T/b.txt', 'writable'), entry('T/c.txt', 'locked', { writer: 'ola' }),
      entry('T/d.txt', 'locked'), entry('T/e.txt', 'local_changed'), entry('T/f.txt', 'conflict'),
    ]), TASKS);
    expect(m.rows.map((r) => [r.name, r.stateText])).toEqual([
      ['a.txt', 'wolny'], ['b.txt', 'moje zadanie'], ['c.txt', 'zablokowany — ola'],
      ['d.txt', 'zablokowany — nikt nie pisze'], ['e.txt', 'czeka na wysłanie'], ['f.txt', 'konflikt'],
    ]);
    expect(m.rows[0]).toMatchObject({ path: 'T/a.txt', folder: false });
  });

  it('offers actions by state', () => {
    const m = treeViewModel(browse([
      entry('T/a.txt', 'free'), entry('T/b.txt', 'writable'), entry('T/c.txt', 'locked'),
      entry('T/X', 'free', { folder: true }), entry('T/Y', 'locked', { folder: true }),
    ]), TASKS);
    expect(m.rows.map((r) => r.actions)).toEqual([
      ['lock', 'history', 'open'], ['history', 'open'], ['requestRelease', 'history', 'open'],
      ['lock', 'open'], ['requestRelease', 'open'],
    ]);
  });

  it('unselected space has no local actions', () => {
    const m = treeViewModel(browse([entry('T/a.txt', 'free', { localPath: null })], { selected: false }), TASKS);
    expect(m.canOpenFolder).toBe(false);
    expect(m.rows[0]!.actions).toEqual(['lock', 'history']);
  });

  it('opens a partly selected space only where it is local', () => {
    const local = treeViewModel(browse([entry('a.txt', 'free'), entry('U', 'free', { folder: true, localPath: null })], { folder: '' }), TASKS);
    expect(local.canOpenFolder).toBe(true);
    expect(local.rows[1]!.actions).toEqual(['lock']);
    const remote = treeViewModel(browse([entry('U/b.txt', 'free', { localPath: null })], { folder: 'U' }), TASKS);
    expect(remote.canOpenFolder).toBe(false);
  });

  it('does not lock in a private space', () => {
    const m = treeViewModel(browse([entry('a.txt', 'free')], { space: 'user:u1' }), TASKS);
    expect(m.rows[0]!.actions).toEqual(['history', 'open']);
  });

  it('links locks to CogniFly tasks', () => {
    const m = treeViewModel(browse([
      entry('T/a.txt', 'writable', { workId: 'cognifly:zad_0123456789ab' }),
      entry('T/b.txt', 'locked', { workId: 'cognifly:zad_aaaaaaaaaaaa' }),
      entry('T/c.txt', 'locked', { workId: 'cognifly:zle' }),
      entry('T/d.txt', 'locked', { workId: 'inny:zad_aaaaaaaaaaaa' }),
      entry('T/e.txt', 'free'),
    ]), TASKS);
    expect(m.rows.map((r) => r.taskLink)).toEqual([
      { taskId: 'zad_0123456789ab', title: 'Oferta' }, { taskId: 'zad_aaaaaaaaaaaa', title: 'zad_aaaaaaaaaaaa' }, null, null, null,
    ]);
  });
});

describe('versionLine of a work version', () => {
  it('reads a version from the task files list', () => {
    expect(versionLine(ver('a.txt', 2))).toMatch(/^Wersja 2 · .+ · u1 · zapis$/);
  });
});
