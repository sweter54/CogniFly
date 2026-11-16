import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { zapiszKontakt } from '../../src/dane/konfiguracja.js';
import { pobierzZadanie, utworzZadanie, wez } from '../../src/dane/kolejka.js';
import { handler, obsluzEskalacje } from '../../src/eskalacja/obsluz.js';

const tabela = ustawTabeleTestowa('cognifly-test-eskalacja');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());

const ses = mockClient(SESv2Client);
const sm = mockClient(SecretsManagerClient);
const fetchMock = vi.fn();
const F = 'fe';
let n = 0;
const zad = (kand: string[], extra: { eskalujDo?: { osoba: string; kanaly: ('email' | 'discord')[] }[] } = {}) =>
  utworzZadanie(F, 'evt_cccccccccccccccccccccccc', kand, { id: `zad_e${++n}`, opis: 'Zrób przegląd PR #7', ...extra });

beforeEach(async () => {
  ses.reset(); sm.reset(); fetchMock.mockReset();
  ses.on(SendEmailCommand).resolves({});
  sm.on(GetSecretValueCommand).resolves({ SecretString: 'https://discord.com/api/webhooks/1/tok' });
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  process.env.COGNIFLY_NADAWCA = 'cognifly@example.com';
  await zapiszKontakt(F, 'ola', { email: 'ola@example.com', discordWebhookRef: 'sekret/ola' });
  await zapiszKontakt(F, 'szef', { email: 'szef@example.com' });
});

describe('obsluzEskalacje', () => {
  test('zadanie wzięte przed eskalacją: POMINIETE, nic nie wysłano', async () => {
    const z = await zad(['ola']);
    await wez(F, z.id, 'ola');
    expect(await obsluzEskalacje({ firma: F, zadanieId: z.id })).toBe('POMINIETE');
    expect(ses.calls()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await pobierzZadanie(F, z.id))?.stan).toBe('wziete');
  });

  test('niewzięte: ESKALOWANE, stan eskalowane, wysyłka do kandydatów (email+discord)', async () => {
    const z = await zad(['ola']);
    expect(await obsluzEskalacje({ firma: F, zadanieId: z.id })).toBe('ESKALOWANE');
    expect((await pobierzZadanie(F, z.id))?.stan).toBe('eskalowane');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content?.Simple?.Body?.Text?.Data).toContain('Zrób przegląd PR #7');
  });

  test('eskalujDo ma pierwszeństwo przed kandydatami', async () => {
    const z = await zad(['ola'], { eskalujDo: [{ osoba: 'szef', kanaly: ['email'] }] });
    expect(await obsluzEskalacje({ firma: F, zadanieId: z.id })).toBe('ESKALOWANE');
    const i = ses.commandCalls(SendEmailCommand);
    expect(i).toHaveLength(1);
    expect(i[0]!.args[0].input.Destination?.ToAddresses).toEqual(['szef@example.com']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('brak zadania: POMINIETE', async () => {
    expect(await obsluzEskalacje({ firma: F, zadanieId: 'zad_nie_ma' })).toBe('POMINIETE');
    expect(ses.calls()).toHaveLength(0);
  });

  test('drugie wywołanie: POMINIETE (stan już eskalowane)', async () => {
    const z = await zad(['ola']);
    await obsluzEskalacje({ firma: F, zadanieId: z.id });
    ses.resetHistory();
    expect(await obsluzEskalacje({ firma: F, zadanieId: z.id })).toBe('POMINIETE');
    expect(ses.calls()).toHaveLength(0);
  });
});

describe('handler', () => {
  test('zły kształt wejścia: bez wyjątku i bez wysyłki', async () => {
    const e = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handler({} as never)).resolves.toBeUndefined();
    await expect(handler(null as never)).resolves.toBeUndefined();
    await expect(handler({ firma: 1, zadanieId: 'x' } as never)).resolves.toBeUndefined();
    expect(ses.calls()).toHaveLength(0);
    e.mockRestore();
  });

  test('poprawne wejście eskaluje', async () => {
    const z = await zad(['ola']);
    await handler({ firma: F, zadanieId: z.id });
    expect((await pobierzZadanie(F, z.id))?.stan).toBe('eskalowane');
  });
});
