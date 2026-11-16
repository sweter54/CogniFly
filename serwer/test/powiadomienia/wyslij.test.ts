import { beforeEach, describe, expect, test, vi, beforeAll, afterAll } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Zdarzenie } from '@cognifly/wspolne';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { zapiszKontakt } from '../../src/dane/konfiguracja.js';
import { wyslijPowiadomienia } from '../../src/powiadomienia/wyslij.js';

const tabela = ustawTabeleTestowa('cognifly-test-wyslij');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());

const ses = mockClient(SESv2Client);
const sm = mockClient(SecretsManagerClient);
const fetchMock = vi.fn();
const z: Zdarzenie = {
  id: 'evt_bbbbbbbbbbbbbbbbbbbbbbbb', firma: 'fw', zrodlo: 'github', typ: 'github.pr.opened',
  czas: '2026-11-16T10:00:00.000Z', podmiot: { repo: 'app' }, opis: 'PR otwarty', wymagaPracy: true,
};

beforeEach(() => {
  ses.reset(); sm.reset(); fetchMock.mockReset();
  ses.on(SendEmailCommand).resolves({});
  sm.on(GetSecretValueCommand).resolves({ SecretString: 'https://discord.com/api/webhooks/1/tok' });
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  process.env.COGNIFLY_NADAWCA = 'cognifly@example.com';
});

describe('wyslijPowiadomienia', () => {
  test('email + discord: oba wysłane', async () => {
    await zapiszKontakt('fw', 'ala', { email: 'ala@example.com', discordWebhookRef: 'sekret/ala' });
    const w = await wyslijPowiadomienia('fw', z, [{ osoba: 'ala', kanaly: ['email', 'discord'] }], 'nowe');
    expect(w).toEqual({ wyslane: 2, bledy: [] });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('błąd Discorda nie blokuje e-maila', async () => {
    await zapiszKontakt('fw', 'bob', { email: 'bob@example.com', discordWebhookRef: 'sekret/bob' });
    fetchMock.mockResolvedValue(new Response('x', { status: 500 }));
    const w = await wyslijPowiadomienia('fw', z, [{ osoba: 'bob', kanaly: ['discord', 'email'] }], 'nowe');
    expect(w.wyslane).toBe(1);
    expect(w.bledy).toHaveLength(1);
    expect(w.bledy[0]).toContain('bob');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  test('kanał claude pomijany i niezliczany', async () => {
    const w = await wyslijPowiadomienia('fw', z, [{ osoba: 'ala', kanaly: ['claude'] }], 'nowe');
    expect(w).toEqual({ wyslane: 0, bledy: [] });
    expect(ses.calls()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('brak kontaktu -> błąd w bledy, bez wyjątku', async () => {
    const w = await wyslijPowiadomienia('fw', z, [{ osoba: 'nikt', kanaly: ['email', 'discord'] }], 'nowe');
    expect(w.wyslane).toBe(0);
    expect(w.bledy).toHaveLength(2);
  });

  test('adres webhooka spoza wzorca -> błąd, bez fetch', async () => {
    await zapiszKontakt('fw', 'zly', { discordWebhookRef: 'sekret/zly' });
    sm.on(GetSecretValueCommand, { SecretId: 'sekret/zly' }).resolves({ SecretString: 'https://evil.example/x' });
    const w = await wyslijPowiadomienia('fw', z, [{ osoba: 'zly', kanaly: ['discord'] }], 'nowe');
    expect(w.wyslane).toBe(0);
    expect(w.bledy).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('błąd Secrets Manager -> w bledy', async () => {
    await zapiszKontakt('fw', 'sm', { discordWebhookRef: 'sekret/brak' });
    sm.on(GetSecretValueCommand, { SecretId: 'sekret/brak' }).rejects(new Error('nie ma'));
    const w = await wyslijPowiadomienia('fw', z, [{ osoba: 'sm', kanaly: ['discord'] }], 'nowe');
    expect(w.wyslane).toBe(0);
    expect(w.bledy).toHaveLength(1);
  });
});
