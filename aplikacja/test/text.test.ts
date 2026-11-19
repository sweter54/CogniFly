import { describe, expect, it } from 'vitest';
import { clip, plural, shortPath } from '../src/logic/text.js';

describe('plural', () => {
  it.each([
    [0, 'zadań'], [1, 'zadanie'], [2, 'zadania'], [4, 'zadania'], [5, 'zadań'], [11, 'zadań'], [12, 'zadań'],
    [14, 'zadań'], [21, 'zadań'], [22, 'zadania'], [101, 'zadań'], [112, 'zadań'], [124, 'zadania'],
  ])('%i → %s', (n, form) => expect(plural(n, 'zadanie', 'zadania', 'zadań')).toBe(form));
});

describe('shortPath', () => {
  const long = '/Users/a/Documents/CogniFlyWorkspace/Pliki/pilot/wspolne/Oferty/plik.txt';

  it('keeps a path that fits', () => {
    expect(shortPath('a/b.txt', 20)).toBe('a/b.txt');
    expect(shortPath(long, long.length)).toBe(long);
  });

  it('keeps the last whole segments behind …/', () => {
    expect(shortPath(long, 30)).toBe('…/wspolne/Oferty/plik.txt');
    expect(shortPath(long, 25)).toBe('…/wspolne/Oferty/plik.txt');
    expect(shortPath(long, 24)).toBe('…/Oferty/plik.txt');
    expect(shortPath(long, 12)).toBe('…/plik.txt');
  });

  it('never cuts a name that fits', () => {
    expect(shortPath(long, 9)).toBe('…plik.txt');
    expect(shortPath(long, 8)).toBe('plik.txt');
  });

  it('ends with the tail of a name longer than the limit', () => {
    expect(shortPath('/x/bardzo-dluga-nazwa.txt', 10)).toBe('…nazwa.txt');
    expect(shortPath('bardzo-dluga-nazwa.txt', 10)).toBe('…nazwa.txt');
  });

  it('keeps the trailing slash of a folder', () => {
    expect(shortPath('/a/bb/cc/folder/', 12)).toBe('…/cc/folder/');
  });

  it('counts characters, not UTF-16 units, and handles tiny limits', () => {
    expect(shortPath('/zażółć/gęślą/jaźń.txt', 16)).toBe('…/gęślą/jaźń.txt');
    expect(shortPath('/a/plik.txt', 1)).toBe('…');
    expect(shortPath('/a/plik.txt', 0)).toBe('…');
  });
});

describe('clip', () => {
  it('keeps short text and cuts long text with …', () => {
    expect(clip('krótki', 10)).toBe('krótki');
    expect(clip('bardzo długi opis zadania', 10)).toBe('bardzo dł…');
    expect(clip('ab   cd', 4)).toBe('ab…');
  });
});
