import { describe, expect, test } from 'vitest';
import { przeczytajOpcje, regulaPilota, zasiej } from '../skrypty/zasiej-pilot.js';

describe('zasiej-pilot (tylko dry-run, bez AWS)', () => {
  test('wymaga e-maila Michała', () => {
    expect(() => przeczytajOpcje([], {})).toThrow(/Michała/);
  });

  test('domyślnie dry-run: wypisuje plan i nie ujawnia wartości sekretów', async () => {
    const o = przeczytajOpcje(['--email-michal', 'm@example.com', '--discord-michal', 'https://sekret.example/hook'], {});
    expect(o.wykonaj).toBe(false);
    const linie: string[] = [];
    await zasiej(o, (s) => linie.push(s));
    const t = linie.join('\n');
    expect(t).toContain('DRY-RUN');
    expect(t).toContain('cognifly-test/github/pilot');
    expect(t).toContain('cognifly-test/discord/pilot/michal');
    expect(t).not.toContain('sekret.example');
  });

  test('reguła pilota zgodna z briefem', () => {
    expect(regulaPilota('michal')).toMatchObject({
      gdy: { zrodlo: 'github', typ: 'github.pr.*' }, firma: 'pilot', eskalacjaMin: 15,
      powiadom: { osoby: ['michal'], kanaly: ['email', 'discord'] }, przydziel: { osoby: ['michal'] },
    });
  });
});
