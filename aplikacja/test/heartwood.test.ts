import { describe, expect, it } from 'vitest';
import {
  fileCounts, forgetLocked, groupBySpace, hwMessage, isUnderRoot, lockedPaths, parseStatus, parseVersions, rememberLocked, workIdFor,
} from '../src/logic/heartwood.js';
import { memoryStore } from '../src/logic/storage.js';
import { STATUS_REPLY } from './helpers.js';


describe('parseStatus', () => {
  it('reads the contract example', () => {
    const s = parseStatus(STATUS_REPLY)!;
    expect(s.running).toBe(true);
    expect(s.spaces[1]).toEqual({ space: 'prv:michal', folder: 'Prywatne', lastSeq: 2, serverSeq: null, unsent: 4 });
    expect(s.conflicts[0]!.copyPath).toBe('b (konflikt).docx');
    expect(s.skipped[0]).toMatchObject({ suggestion: 'x_y', hint: 'zmień nazwę na „x_y”' });
    expect(s.skipped[1]!.hint).toBeUndefined();
    expect(s.pending[0]).toMatchObject({ op: 'put', path: 'a.txt' });
    expect(s.issues).toEqual([{ space: '', message: 'Brak połączenia z serwerem.' }]);
  });

  it.each([null, 'x', 42, {}, { ok: false, code: 'X' }, { ...STATUS_REPLY, spaces: 'a' }, { ...STATUS_REPLY, conflicts: [{ space: 1 }] }])(
    'refuses junk %j', (v) => expect(parseStatus(v)).toBeNull(),
  );
});

describe('fileCounts', () => {
  it('counts conflicts and sums unsent', () => {
    expect(fileCounts(parseStatus(STATUS_REPLY))).toEqual({ conflicts: 2, unsent: 7 });
    expect(fileCounts(null)).toEqual({ conflicts: 0, unsent: 0 });
  });
});

describe('paths and ids', () => {
  it('builds the work id', () => expect(workIdFor('zad_0123456789ab')).toBe('cognifly:zad_0123456789ab'));

  it.each([
    ['/Users/a/Heartwood/pilot/wspolne/x.docx', true],
    ['/Users/a/Heartwood2/x', false],
    ['/Users/a/Heartwood/../x', false],
    ['/Users/a/Heartwood/./x', false],
    ['/Users/a/Heartwood', false],
    ['Users/a/Heartwood/x', false],
  ])('%s under /Users/a/Heartwood → %s', (path, under) => expect(isUnderRoot(path, '/Users/a/Heartwood')).toBe(under));

  it('an empty root accepts nothing', () => expect(isUnderRoot('/x/y', '')).toBe(false));

  it('groups paths by space folder', () => {
    const root = '/R';
    expect(groupBySpace(['/R/pilot/w1/a', '/R/pilot/w2/b', '/R/pilot/w1/c/d'], root)).toEqual([['/R/pilot/w1/a', '/R/pilot/w1/c/d'], ['/R/pilot/w2/b']]);
  });
});

describe('hwMessage', () => {
  it.each([
    ['NOT_RUNNING', undefined, 'Heartwood nie działa — uruchamiam ponownie…'],
    ['NOT_INSTALLED', undefined, 'Heartwood nie jest zainstalowany na tym komputerze.'],
    ['DISABLED', undefined, 'Pliki nie są jeszcze włączone w tej wersji CogniFly.'],
    ['TIMEOUT', undefined, 'Heartwood nie odpowiada.'],
    ['LOCKED', 'Plik blokuje Ania.', 'Plik blokuje Ania.'],
    ['LOCKED', undefined, 'Nie udało się (LOCKED).'],
  ])('%s', (code, message, text) => expect(hwMessage(code, message)).toBe(text));
});

describe('locked paths memory', () => {
  it('remembers without duplicates and forgets', () => {
    const store = memoryStore();
    expect(lockedPaths(store, 'zad_1')).toEqual([]);
    rememberLocked(store, 'zad_1', ['/a', '/b']);
    rememberLocked(store, 'zad_1', ['/b', '/c']);
    rememberLocked(store, 'zad_2', ['/z']);
    expect(lockedPaths(store, 'zad_1')).toEqual(['/a', '/b', '/c']);
    forgetLocked(store, 'zad_1', ['/a', '/b']);
    expect(lockedPaths(store, 'zad_1')).toEqual(['/c']);
    forgetLocked(store, 'zad_1', ['/c']);
    expect(JSON.parse(store.getItem('cognifly.heartwood.locks')!)).toEqual({ zad_2: ['/z'] });
  });

  it('ignores corrupt storage', () => {
    const store = memoryStore();
    store.setItem('cognifly.heartwood.locks', '{"zad_1": [1, "/a"]}');
    expect(lockedPaths(store, 'zad_1')).toEqual(['/a']);
  });
});

describe('parseVersions', () => {
  it('keeps well-formed records only', () => {
    const v = { seq: 3, versionId: 'v3', sha256: 'ab', size: 10, author: 'ania', at: '2026-11-19T10:00:00Z', kind: 'put' };
    expect(parseVersions([v, { seq: 'x' }, null])).toEqual([v]);
    expect(parseVersions('x')).toEqual([]);
  });
});
