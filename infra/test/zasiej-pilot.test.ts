import { describe, expect, test, vi } from 'vitest';
import { ResourceNotFoundException, CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { przeczytajOpcje, regulaPilota, zasiej, type Zaleznosci } from '../skrypty/zasiej-pilot.js';

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
    expect(t).toContain('Tożsamości');
    expect(t).not.toContain('Cognito: użytkownik');
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

describe('zasiej-pilot --wykonaj na atrapach (bez AWS)', () => {
  const zbuduj = (opcje: { istniejacySekret: boolean; kontakt?: { discordWebhookRef?: string } }) => {
    const sm = { send: vi.fn(async (c: unknown) => {
      if (c instanceof DescribeSecretCommand && !opcje.istniejacySekret) {
        throw new ResourceNotFoundException({ message: 'brak', $metadata: {} });
      }
      return {};
    }) };
    const dane = {
      zapiszRegule: vi.fn(async () => {}),
      zapiszKontakt: vi.fn(async () => {}), kontaktOsoby: vi.fn(async () => opcje.kontakt ?? {}),
      zapiszLoginGithub: vi.fn(async () => {}),
    };
    return { sm, dane, zal: { sm, dane } as unknown as Zaleznosci };
  };
  const opcje = (...a: string[]) => przeczytajOpcje(['--email-michal', 'm@example.com', '--wykonaj', ...a], {});
  const polecenia = (sm: { send: { mock: { calls: unknown[][] } } }, K: new (...a: never[]) => unknown) =>
    sm.send.mock.calls.filter(([c]) => c instanceof K);

  test('istniejący sekret GitHuba bez --sekret-github zostaje nietknięty', async () => {
    const m = zbuduj({ istniejacySekret: true });
    await zasiej(opcje(), () => {}, m.zal);
    expect(polecenia(m.sm, CreateSecretCommand)).toHaveLength(0);
    expect(polecenia(m.sm, PutSecretValueCommand)).toHaveLength(0);
  });

  test('brakujący sekret GitHuba jest tworzony, a jawnie podany nadpisywany', async () => {
    const m = zbuduj({ istniejacySekret: false });
    await zasiej(opcje(), () => {}, m.zal);
    expect(polecenia(m.sm, CreateSecretCommand)).toHaveLength(1);
    const m2 = zbuduj({ istniejacySekret: true });
    await zasiej(opcje('--sekret-github', 'jawny'), () => {}, m2.zal);
    expect(polecenia(m2.sm, DescribeSecretCommand)).toHaveLength(0);
  });

  test('ponowny przebieg bez --discord nie gubi discordWebhookRef w kontakcie', async () => {
    const m = zbuduj({ istniejacySekret: true, kontakt: { discordWebhookRef: 'cognifly-test/discord/pilot/michal' } });
    await zasiej(opcje(), () => {}, m.zal);
    expect(m.dane.zapiszKontakt).toHaveBeenCalledWith('pilot', 'michal', {
      email: 'm@example.com', discordWebhookRef: 'cognifly-test/discord/pilot/michal',
    });
  });

  test('no_cognito_and_no_person_records: only contact and rule are written', async () => {
    const m = zbuduj({ istniejacySekret: true });
    await zasiej(opcje(), () => {}, m.zal);
    expect(Object.keys(m.dane).sort()).toEqual(
      ['kontaktOsoby', 'zapiszKontakt', 'zapiszLoginGithub', 'zapiszRegule']);
    expect(m.dane.zapiszKontakt).toHaveBeenCalledTimes(1);
    expect(m.dane.zapiszRegule).toHaveBeenCalledTimes(1);
  });

  test('--pula is not an option anymore', () => {
    expect(() => przeczytajOpcje(['--email-michal', 'm@x.pl', '--pula', 'p'], {})).toThrow();
  });

  test('--github-michal wiąże login GitHub z osobą; bez opcji nic nie zapisuje', async () => {
    const m = zbuduj({ istniejacySekret: true });
    await zasiej(opcje('--github-michal', 'sweter54'), () => {}, m.zal);
    expect(m.dane.zapiszLoginGithub).toHaveBeenCalledWith('pilot', 'sweter54', 'michal');
    const m2 = zbuduj({ istniejacySekret: true });
    await zasiej(opcje(), () => {}, m2.zal);
    expect(m2.dane.zapiszLoginGithub).not.toHaveBeenCalled();
  });
});
