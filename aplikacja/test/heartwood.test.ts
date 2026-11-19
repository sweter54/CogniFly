import { describe, expect, it } from 'vitest';
import {
  checkReply, heartwoodRoot, fileCounts, groupBySpace, hwMessage, isSpacePath, isUnderRoot, locksBySpace, parseBrowse, parseStatus, parseVersions, parseWorkFiles, workIdFor,
} from '../src/logic/heartwood.js';
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

describe('space paths', () => {
  it.each([
    ['a.docx', false, true], ['Oferty/a.docx', false, true], ['', false, false], ['a/', false, false],
    ['/a', false, false], ['a//b', false, false], ['../a', false, false], ['a/./b', false, false], ['a\u0000b', false, false],
    ['', true, true], ['Oferty/', true, true], ['Oferty', true, true], ['/', true, false], ['a//', true, false], ['../', true, false],
  ])('%j (folder %s) → %s', (path, folderOk, ok) => expect(isSpacePath(path, folderOk)).toBe(ok));

  it('groups work locks by space in order of first appearance', () => {
    const lock = (space: string, path: string) => ({ space, path, folder: false, by: 'u', at: '', workId: 'w', writer: null, localPath: null });
    expect(locksBySpace([lock('ws:a', 'x'), lock('ws:b', 'y'), lock('ws:a', 'z')])).toEqual([
      { space: 'ws:a', paths: ['x', 'z'] }, { space: 'ws:b', paths: ['y'] },
    ]);
  });
});

describe('checkReply', () => {
  it('passes ok replies and turns refusals into codes with a clean text', () => {
    expect(() => checkReply({ ok: true })).not.toThrow();
    expect(() => checkReply({ ok: false, code: 'LOCKED', message: 'Plik\u0007 blokuje\nAnia.' })).toThrow(expect.objectContaining({ code: 'LOCKED', text: 'Plik blokuje Ania.' }));
    expect(() => checkReply({ ok: false, code: 'LOCKED', message: 'x'.repeat(500) })).toThrow(expect.objectContaining({ text: 'x'.repeat(300) }));
    expect(() => checkReply({ ok: false, code: 'zle kody' })).toThrow(expect.objectContaining({ code: 'BAD_RESPONSE', text: undefined }));
  });
});

describe('parseVersions', () => {
  it('keeps well-formed records only', () => {
    const v = { seq: 3, versionId: 'v3', sha256: 'ab', size: 10, author: 'ania', at: '2026-11-19T10:00:00Z', kind: 'put' };
    expect(parseVersions([v, { seq: 'x' }, null])).toEqual([v]);
    expect(parseVersions('x')).toEqual([]);
  });
});

const LOCK = {
  ws: 'w1', space: 'ws:w1', path: 'Oferty/a.docx', workId: 'cognifly:zad_0123456789ab', folder: false,
  by: 'u1', at: '2026-11-19T10:00:00Z', writer: 'u1', localPath: '/R/pilot/w1/Oferty/a.docx',
};
const VERSION = {
  space: 'ws:w1', path: 'Oferty/a.docx', seq: 7, versionId: 'v7', sha256: 'ab', size: 3, author: 'u1',
  workId: 'cognifly:zad_0123456789ab', at: '2026-11-19T11:00:00Z', kind: 'put', localPath: null,
};
const WORK = { ok: true, writer: 'u1', closed: false, locks: [LOCK], hiddenLocks: 2, versions: [VERSION], cursor: 'c1' };

describe('parseWorkFiles', () => {
  it('reads the contract shape with localPath', () => {
    const w = parseWorkFiles(WORK)!;
    expect(w).toMatchObject({ writer: 'u1', closed: false, hiddenLocks: 2, cursor: 'c1' });
    expect(w.locks).toEqual([{
      space: 'ws:w1', path: 'Oferty/a.docx', folder: false, by: 'u1', at: '2026-11-19T10:00:00Z',
      workId: 'cognifly:zad_0123456789ab', writer: 'u1', localPath: '/R/pilot/w1/Oferty/a.docx',
    }]);
    expect(w.versions).toEqual([{
      space: 'ws:w1', path: 'Oferty/a.docx', seq: 7, author: 'u1', at: '2026-11-19T11:00:00Z', kind: 'put', localPath: null,
    }]);
  });

  it('reads an unknown work as empty lists', () => {
    expect(parseWorkFiles({ ok: true, writer: null, closed: false, locks: [], hiddenLocks: 0, versions: [] }))
      .toEqual({ writer: null, closed: false, locks: [], hiddenLocks: 0, versions: [] });
  });

  it('drops bad rows one by one and treats a missing localPath as null', () => {
    const { localPath: _l, ...noLocal } = LOCK;
    const w = parseWorkFiles({
      ...WORK,
      locks: [LOCK, { ...LOCK, folder: 'x' }, { ...LOCK, writer: 5 }, null, noLocal],
      versions: [VERSION, { ...VERSION, kind: 'zap' }, { ...VERSION, seq: -1 }, { ...VERSION, kind: 'move', fromPath: 'b.docx' }],
    })!;
    expect(w.locks).toHaveLength(2);
    expect(w.locks[1]!.localPath).toBeNull();
    expect(w.versions.map((v) => v.kind)).toEqual(['put', 'move']);
    expect(w.versions[1]!.fromPath).toBe('b.docx');
  });

  it.each([
    null, 'x', [], { ok: false, code: 'NETWORK' }, { ...WORK, writer: 1 }, { ...WORK, closed: 'no' },
    { ...WORK, hiddenLocks: -1 }, { ...WORK, locks: 'x' }, { ...WORK, versions: {} }, { ...WORK, cursor: 3 },
  ])('refuses junk %j', (v) => expect(parseWorkFiles(v)).toBeNull());
});

const ENTRY = { path: 'T/a.txt', localPath: '/R/pilot/w1/T/a.txt', folder: false, size: 3, state: 'free', lockFolder: false };
const BROWSE = {
  ok: true, space: 'ws:w1', folder: 'T', selected: true,
  entries: [{ path: 'T/X', localPath: null, folder: true, state: 'locked', workId: 'wk:1', writer: 'ola', lockFolder: true }, ENTRY],
};

describe('parseBrowse', () => {
  it('reads one folder level', () => {
    const b = parseBrowse(BROWSE)!;
    expect(b).toMatchObject({ space: 'ws:w1', folder: 'T', selected: true });
    expect(b.entries[0]).toEqual({ path: 'T/X', localPath: null, folder: true, state: 'locked', workId: 'wk:1', writer: 'ola', lockFolder: true });
    expect(b.entries[1]).toEqual(ENTRY);
  });

  it('drops bad entries one by one', () => {
    const b = parseBrowse({
      ...BROWSE,
      entries: [ENTRY, { ...ENTRY, state: 'gone' }, { ...ENTRY, size: 'big' }, { ...ENTRY, folder: 1 }, { ...ENTRY, localPath: 4 }, 'x'],
    })!;
    expect(b.entries).toEqual([ENTRY]);
  });

  it.each([
    null, 7, { ok: false, code: 'NOT_FOUND' }, { ...BROWSE, space: 1 }, { ...BROWSE, folder: null },
    { ...BROWSE, selected: 'yes' }, { ...BROWSE, entries: 'x' },
  ])('refuses junk %j', (v) => expect(parseBrowse(v)).toBeNull());
});

describe('heartwoodRoot', () => {
  it('puts Heartwood in Pliki inside the work folder', () => {
    expect(heartwoodRoot('/Users/m/Praca')).toBe('/Users/m/Praca/Pliki');
    expect(heartwoodRoot('/Users/m/Praca/')).toBe('/Users/m/Praca/Pliki');
    expect(heartwoodRoot('')).toBe('');
  });
});
