import { describe, expect, it } from 'vitest';
import {
  checkReply, existingTaskFolder, heartwoodRoot, fileCounts, groupBySpace, hwMessage, isConflictCopy, isSpacePath, isUnderRoot, locksBySpace, parseAdopt,
  parseBrowse, parseStatus, parseVersions, parseWorkFiles, taskFolderName, workIdFor,
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

  it.each([null, 'x', 42, {}, { ok: false, code: 'X' }, { ...STATUS_REPLY, spaces: 'a' }, { ...STATUS_REPLY, conflicts: 'x' }])(
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

describe('parseStatus: untracked files and grouped conflicts', () => {
  it('reads untracked rows', () => {
    const s = parseStatus(STATUS_REPLY)!;
    expect(s.untracked).toEqual([
      { space: 'ws:w1', path: 'Oferty/nowy.docx', folder: false, reason: 'no_lock', reasonText: 'brak blokady — dołącz do zadania, żeby wysłać' },
      { space: 'ws:w1', path: 'luzem.txt', folder: false, reason: 'no_topic', reasonText: 'poza tematem — przenieś do zadania' },
    ]);
  });

  it('reads count and copies of a grouped conflict', () => {
    const c = parseStatus(STATUS_REPLY)!.conflicts[0]!;
    expect(c.count).toBe(2);
    expect(c.copies).toEqual([
      { copyPath: 'b (konflikt).docx', at: '2026-11-19T10:00:00Z' },
      { copyPath: 'b (konflikt 2).docx', at: '2026-11-18T09:00:00Z' },
    ]);
  });

  it('fills count and copies for an older daemon without them', () => {
    const s = parseStatus({ ...STATUS_REPLY, untracked: undefined })!;
    expect(s.untracked).toEqual([]);
    expect(s.conflicts[1]).toMatchObject({ count: 1, copies: [{ copyPath: 'c (konflikt).docx', at: '2026-11-19T10:01:00Z' }] });
  });

  it('a conflict without a copy on disk has no copies', () => {
    const c = { space: 'ws:w1', path: 'd.docx', copyPath: '', at: 'T', message: 'm' };
    expect(parseStatus({ ...STATUS_REPLY, conflicts: [c] })!.conflicts[0]).toMatchObject({ copyPath: '', count: 1, copies: [] });
  });

  const conflict = STATUS_REPLY.conflicts[0]!;
  const loose = STATUS_REPLY.untracked[0]!;
  it('a non-list untracked field is a malformed status', () => expect(parseStatus({ ...STATUS_REPLY, untracked: 'x' })).toBeNull());

  it('drops bad untracked rows one by one', () => {
    const s = parseStatus({ ...STATUS_REPLY, untracked: [{ ...loose, folder: 'no' }, loose, { ...loose, reasonText: 3 }, 'x'] })!;
    expect(s.untracked).toEqual([loose]);
  });

  it('drops bad conflict rows one by one, keeping the rest of the status', () => {
    const bad = [{ ...conflict, count: -1 }, { ...conflict, count: 1.5 }, { ...conflict, copies: 'x' }, { ...conflict, path: 3 }, null];
    const s = parseStatus({ ...STATUS_REPLY, conflicts: [...bad, conflict] })!;
    expect(s.conflicts.map((c) => c.path)).toEqual(['b.docx']);
    expect(s.spaces).toHaveLength(2);
  });

  it('drops bad copies one by one', () => {
    const copies = [{ copyPath: 1, at: 'T' }, { copyPath: 'k.docx', at: 'T' }];
    expect(parseStatus({ ...STATUS_REPLY, conflicts: [{ ...conflict, copies }] })!.conflicts[0]!.copies).toEqual([{ copyPath: 'k.docx', at: 'T' }]);
  });
});

describe('parseBrowse: untracked entries', () => {
  it('accepts the untracked state', () => {
    const b = parseBrowse({ ok: true, space: 'ws:w1', folder: '', selected: true, entries: [{ path: 'n.txt', localPath: '/R/n.txt', folder: false, state: 'untracked', lockFolder: false }] })!;
    expect(b.entries[0]!.state).toBe('untracked');
  });
});

describe('taskFolderName', () => {
  const ID = 'zad_0123456789ab';
  const named = (opis: string) => taskFolderName({ id: ID, opis });

  it('keeps a plain description', () => expect(named('Oferta dla Acme')).toBe(`Oferta dla Acme (${ID})`));

  it('removes forbidden and control characters and collapses spaces', () => {
    expect(named('Raport: Q3/Q4 \\ "final"? <a|b>*')).toBe(`Raport Q3-Q4 - final ab (${ID})`);
    expect(named('PR #10 (repo sweter54/CogniFly)')).toBe(`PR #10 (repo sweter54-CogniFly) (${ID})`);
    expect(named('a\u0007b\tc\n\nd')).toBe(`ab c d (${ID})`);
  });

  it('an empty or fully removed description gives only the id', () => {
    expect(named('')).toBe(`(${ID})`);
    expect(named(' /:*? ')).toBe(`(${ID})`);
  });

  it('cuts 300 characters to at most 60 code points without a trailing space', () => {
    const long = `${'abcd '.repeat(11)}efgh${'x'.repeat(240)}`;
    const name = named(long);
    const head = name.slice(0, -` (${ID})`.length);
    expect(Array.from(head).length).toBeLessThanOrEqual(60);
    expect(head).toBe(`${'abcd '.repeat(11)}efgh${'x'.repeat(1)}`);
    expect(named(`${'a'.repeat(59)} bbbb`)).toBe(`${'a'.repeat(59)} (${ID})`);
  });

  it('counts emoji as one code point and never splits a surrogate pair', () => {
    const name = named(`${'😀'.repeat(70)}`);
    const head = name.slice(0, -` (${ID})`.length);
    expect(Array.from(head)).toHaveLength(60);
    expect(head).toBe('😀'.repeat(60));
  });

  it('a mixed nasty description gives one valid name segment', () => {
    const name = named(`  .~$Zadanie: 🚀 /etc/passwd ${'ż'.repeat(300)}  `);
    const head = name.slice(0, -` (${ID})`.length);
    expect(name.endsWith(` (${ID})`)).toBe(true);
    expect(Array.from(head).length).toBeLessThanOrEqual(60);
    expect(name).not.toMatch(/[/\\:*?"<>|\p{Cc}]/u);
    expect(head).toBe(head.trim());
    expect(head.startsWith('Zadanie 🚀 -etc-passwd')).toBe(true);
  });

  it('normalizes to NFC', () => expect(named('Zażółć')).toBe(`Zażółć (${ID})`));

  it.each([
    ['con.txt', `_con.txt (${ID})`],
    ['COM1.x', `_COM1.x (${ID})`],
    ['lpt9.', `_lpt9. (${ID})`],
    ['Nul.txt notatki', `_Nul.txt notatki (${ID})`],
    ['aux', `aux (${ID})`],
    ['COM10.txt', `COM10.txt (${ID})`],
  ])('escapes a reserved device name: %s', (opis, name) => expect(named(opis)).toBe(name));

  it('a reserved name at full length stays within 60 code points', () => {
    const head = named(`con.${'x'.repeat(100)}`).slice(0, -` (${ID})`.length);
    expect(head).toBe(`_con.${'x'.repeat(55)}`);
  });

  it.each([
    'con.txt', 'COM1.x', 'lpt9.', 'Nul.txt notatki', ' . ~$ ', 'ab. '.repeat(40), 'a:b', 'x\u0007', 'plik.', ' plik',
    'what?', 'a\\b', '😀'.repeat(80), `${'é'.repeat(59)} `, ' x ', `prn.${'a'.repeat(70)}`,
  ])('makes a valid Heartwood segment from %j', (opis) => expect(segmentError(named(opis))).toBeNull());
});

describe('existingTaskFolder', () => {
  const ID = 'zad_0123456789ab';
  const level = (entries: unknown[]) => parseBrowse({ ok: true, space: 'ws:w1', folder: 'Zadania', selected: true, entries })!;
  const dir = (path: string, folder = true) => ({ path, localPath: null, folder, state: 'free', lockFolder: false });

  it('finds the folder ending with the task id', () => {
    const b = level([dir('Zadania/Inne (zad_999999999999)'), dir(`Zadania/Stara nazwa (${ID})`)]);
    expect(existingTaskFolder(b, ID)).toBe(`Stara nazwa (${ID})`);
  });

  it('ignores files and other ids', () => {
    expect(existingTaskFolder(level([dir(`Zadania/X (${ID})`, false), dir(`Zadania/X (${ID}x)`), dir(`Zadania/X ${ID}`)]), ID)).toBeNull();
  });

  it('accepts the bare id folder', () => expect(existingTaskFolder(level([dir(`Zadania/(${ID})`)]), ID)).toBe(`(${ID})`));
});

describe('isConflictCopy', () => {
  const R = '/Users/a/Heartwood';
  it.each([
    [`${R}/pilot/w1/Oferty/Kopie konfliktów/a (konflikt 2026-11-19 10-00).docx`, true],
    [`${R}/pilot/w1/Kopie konfliktów/a.docx`, true],
    [`${R}/pilot/w1/Oferty/KOPIE KONFLIKTÓW/a.docx`, true],
    [`${R}/pilot/w1/Oferty/Kopie konfliktów/a.docx`, true],
    [`${R}/.heartwood-kopie/pilot/w1/a.docx`, true],
    [`${R}/pilot/w1/Oferty/a.docx`, false],
    [`${R}/pilot/w1/Kopie konfliktów`, false],
    [`${R}/pilot/w1/Kopie konfliktów/../../x.docx`, false],
    ['/tmp/Kopie konfliktów/a.docx', false],
    [`${R}2/Kopie konfliktów/a.docx`, false],
  ])('%s → %s', (path, ok) => expect(isConflictCopy(path, R)).toBe(ok));
});

describe('parseAdopt', () => {
  it('reads the folder and moved files', () => {
    const r = { ok: true, space: 'ws:w1', folder: 'Zadania/X (zad_0123456789ab)', moved: [{ from: '/R/a', to: '/R/Zadania/X/a' }, { from: 1 }] };
    expect(parseAdopt(r)).toEqual({ folder: 'Zadania/X (zad_0123456789ab)', moved: [{ from: '/R/a', to: '/R/Zadania/X/a' }] });
  });

  it.each([null, { ok: true }, { ok: true, folder: 1, moved: [] }, { ok: true, folder: 'Z', moved: 'x' }])(
    'refuses junk %j', (v) => expect(parseAdopt(v)).toBeNull(),
  );
});

describe('hwMessage for adopt and copies', () => {
  it.each([
    ['TASK_NOT_LOCKABLE', undefined, 'Do tego zadania nie można teraz dołączyć plików.'],
    ['NOT_COPY', undefined, 'To nie jest kopia konfliktu.'],
    ['NOT_WRITER', 'Nie piszesz w tym zadaniu.', 'Nie piszesz w tym zadaniu.'],
    ['FORBIDDEN', undefined, 'Nie udało się (FORBIDDEN).'],
  ])('%s', (code, message, text) => expect(hwMessage(code, message)).toBe(text));
});

/**
 * Heartwood segment rules (client/src/names.rs `validate_segment`).
 *
 * Call: `segmentError(name)`.
 * Expects: one path segment.
 * Output: the first broken rule, or `null` for a valid name.
 */
function segmentError(seg: string): string | null {
  if (seg === '') return 'EMPTY_SEGMENT';
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(seg)) return 'FORBIDDEN_CHAR';
  if (seg.startsWith(' ')) return 'LEADING_SPACE';
  if (/[ .]$/.test(seg)) return 'TRAILING_SPACE_OR_DOT';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(seg.split('.')[0]!.normalize('NFC').toLowerCase())) return 'RESERVED_NAME';
  return Array.from(seg.normalize('NFC')).length > 255 ? 'SEGMENT_TOO_LONG' : null;
}
