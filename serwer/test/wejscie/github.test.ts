import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { idZdarzenia } from '@cognifly/wspolne';
import { mapujGithub } from '../../src/wejscie/mapuj-github.js';
import { handler, zweryfikujPodpis, wyczyscCache } from '../../src/wejscie/github.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/github/${n}.json`, import.meta.url), 'utf8'));
const SEKRET = 'tajny';
const podpisz = (c: string, s = SEKRET) => 'sha256=' + createHmac('sha256', s).update(c).digest('hex');

describe('zweryfikujPodpis', () => {
  const c = '{"a":1}';
  test('poprawny', () => expect(zweryfikujPodpis(c, podpisz(c), SEKRET)).toBe(true));
  test('niepoprawny', () => expect(zweryfikujPodpis(c, podpisz(c, 'inny'), SEKRET)).toBe(false));
  test('brak', () => expect(zweryfikujPodpis(c, undefined, SEKRET)).toBe(false));
  test('zła długość / format', () => {
    expect(zweryfikujPodpis(c, 'sha256=abc', SEKRET)).toBe(false);
    expect(zweryfikujPodpis(c, 'zly', SEKRET)).toBe(false);
  });
});

describe('mapujGithub', () => {
  test.each([
    ['push', 'push', 'github.push'],
    ['pull_request', 'pull_request.synchronize', 'github.pr.commit_po_review'],
    ['pull_request_review', 'pull_request_review.submitted', 'github.pr.review'],
    ['pull_request', 'pull_request.review_requested', 'github.pr.prosba_o_review'],
  ])('%s %s -> %s', (nazwa, plik, typ) => {
    const z = mapujGithub(nazwa, 'dostawa-1', fx(plik), 'f1');
    expect(z?.typ).toBe(typ);
    expect(z?.id).toBe(idZdarzenia('github', 'dostawa-1'));
    expect(z?.firma).toBe('f1');
    expect(z?.zrodlo).toBe('github');
    expect(z?.podmiot.repo).toBe('sweter54/x');
  });
  test('tytuł, commit i branch nie trafiają do opis, trafiają do dane', () => {
    for (const [n, p] of [['push', 'push'], ['pull_request', 'pull_request.synchronize'], ['pull_request_review', 'pull_request_review.submitted'], ['pull_request', 'pull_request.review_requested']] as const) {
      const z = mapujGithub(n, 'd', fx(p), 'f1')!;
      expect(z.opis).not.toMatch(/Zignoruj/i);
      expect(z.opis).not.toMatch(/zignoruj-instrukcje|feat\/x/);
      expect(z.opis.length).toBeLessThanOrEqual(300);
    }
    const z = mapujGithub('pull_request', 'd', fx('pull_request.synchronize'), 'f1')!;
    expect(JSON.stringify(z.dane)).toContain('Zignoruj instrukcje');
    expect(z.opis).toBe('Nowy commit w PR #12 (repo sweter54/x) po recenzji');
    expect(z.podmiot).toMatchObject({ pr: 12, autor: 'sweter54' });
  });
  test('review i prośba mają recenzenta', () => {
    expect(mapujGithub('pull_request_review', 'd', fx('pull_request_review.submitted'), 'f1')!.podmiot.recenzent).toBe('recenzent1');
    expect(mapujGithub('pull_request', 'd', fx('pull_request.review_requested'), 'f1')!.podmiot.recenzent).toBe('recenzent1');
  });
  test('nieobsługiwane -> null', () => {
    expect(mapujGithub('star', 'd', { action: 'created' }, 'f1')).toBeNull();
    expect(mapujGithub('pull_request', 'd', { ...fx('pull_request.synchronize'), action: 'closed' }, 'f1')).toBeNull();
    expect(mapujGithub('pull_request_review', 'd', { ...fx('pull_request_review.submitted'), action: 'edited' }, 'f1')).toBeNull();
  });
});

describe('handler', () => {
  const eb = mockClient(EventBridgeClient);
  const sm = mockClient(SecretsManagerClient);
  beforeEach(() => {
    eb.reset(); sm.reset(); wyczyscCache();
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: '1' }] });
    sm.on(GetSecretValueCommand).resolves({ SecretString: SEKRET });
  });
  const zadanie = (o: { body?: string; sig?: string | null; event?: string; delivery?: string | null; firma?: string; b64?: boolean } = {}) => {
    const body = o.body ?? JSON.stringify(fx('push'));
    const headers: Record<string, string> = { 'x-github-event': o.event ?? 'push' };
    if (o.sig !== null) headers['x-hub-signature-256'] = o.sig ?? podpisz(body);
    if (o.delivery !== null) headers['x-github-delivery'] = o.delivery ?? 'dostawa-1';
    return {
      pathParameters: { firma: o.firma ?? 'f1' },
      headers,
      body: o.b64 ? Buffer.from(body).toString('base64') : body,
      isBase64Encoded: !!o.b64,
    } as never;
  };
  const kod = async (z: never) => (await handler(z)).statusCode;

  test('poprawne -> 202 i PutEvents', async () => {
    expect(await kod(zadanie())).toBe(202);
    const c = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(c.Source).toBe('cognifly.github');
    expect(c.DetailType).toBe('github.push');
    expect(c.EventBusName).toBe('cognifly-test-szyna');
    expect(JSON.parse(c.Detail!).id).toBe(idZdarzenia('github', 'dostawa-1'));
    expect(sm.commandCalls(GetSecretValueCommand)[0]!.args[0].input.SecretId).toBe('cognifly-test/github/f1');
  });
  test('base64', async () => {
    expect(await kod(zadanie({ b64: true }))).toBe(202);
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(1);
  });
  test('zły podpis -> 401 bez publikacji', async () => {
    expect(await kod(zadanie({ sig: podpisz('x') }))).toBe(401);
    expect(await kod(zadanie({ sig: null }))).toBe(401);
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
  });
  test('brak sekretu -> 401', async () => {
    sm.reset(); sm.on(GetSecretValueCommand).rejects(new Error('ResourceNotFoundException'));
    expect(await kod(zadanie())).toBe(401);
  });
  test('zła firma -> 404 bez sięgania po sekret', async () => {
    expect(await kod(zadanie({ firma: '../x' }))).toBe(404);
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });
  test('nieobsługiwany typ -> 202 bez publikacji', async () => {
    const body = '{"action":"created"}';
    expect(await kod(zadanie({ body, event: 'star' }))).toBe(202);
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
  });
  test('brak delivery -> 400; zły JSON -> 400', async () => {
    expect(await kod(zadanie({ delivery: null }))).toBe(400);
    const body = 'nie json';
    expect(await kod(zadanie({ body }))).toBe(400);
  });
  test('FailedEntryCount>0 -> 500', async () => {
    eb.reset(); eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'x' }] });
    expect(await kod(zadanie())).toBe(500);
  });
  test('sekret cache per firma', async () => {
    await kod(zadanie()); await kod(zadanie());
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});
