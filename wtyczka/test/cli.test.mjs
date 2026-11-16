import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'cognifly.mjs');
const TOK = { access: 'ACCESS-TOKEN-AAA', id: 'ID-TOKEN-BBB', refresh: 'REFRESH-TOKEN-CCC', access2: 'ACCESS-TOKEN-NEW' };

function serwer(handler) {
  const log = [];
  const s = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const wpis = { method: req.method, url: req.url, headers: req.headers, body: b ? JSON.parse(b) : undefined };
      log.push(wpis);
      const r = handler(wpis) ?? { status: 404, body: {} };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ s, log, url: `http://127.0.0.1:${s.address().port}` })));
}

let kat, tmp, api, cog, konf;
const sesjaPlik = () => join(kat, 'sesja.json');
const zapiszSesje = (wygasa, access = TOK.access) =>
  writeFileSync(sesjaPlik(), JSON.stringify({ accessToken: access, idToken: TOK.id, refreshToken: TOK.refresh, wygasa }), { mode: 0o600 });

function cli(args, extraEnv = {}) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, COGNIFLY_KATALOG: kat, COGNIFLY_KONFIGURACJA: konf,
        COGNIFLY_ADRES_API: api.url, COGNIFLY_COGNITO_ENDPOINT: cog.url, ...extraEnv },
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => {
      let json; try { json = JSON.parse(out); } catch {}
      ok({ out, err, code, json });
    });
  });
}

let apiHandler, cogHandler;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cog-'));
  kat = join(tmp, 'kat');
  konf = join(tmp, 'konf.json');
  writeFileSync(konf, JSON.stringify({ adresApi: 'http://x', region: 'eu-central-1', klientCognito: 'KLIENT1', firmaDomyslna: 'firma1' }));
  apiHandler = () => ({ status: 200, body: {} });
  cogHandler = () => ({ status: 400, body: { __type: 'X' } });
  api = await serwer((r) => apiHandler(r));
  cog = await serwer((r) => cogHandler(r));
});
afterEach(() => { api.s.close(); cog.s.close(); rmSync(tmp, { recursive: true, force: true }); });

const op = (r) => r.headers['x-amz-target'].split('.')[1];

describe('logowanie', () => {
  it('zaloguj -> KOD_WYSLANY, oczekujace 600; kod -> ZALOGOWANO, sesja 600', async () => {
    cogHandler = (r) => {
      if (op(r) === 'InitiateAuth') {
        expect(r.body).toEqual({ AuthFlow: 'USER_AUTH', ClientId: 'KLIENT1', AuthParameters: { USERNAME: 'a@b.pl', PREFERRED_CHALLENGE: 'EMAIL_OTP' } });
        expect(r.headers['content-type']).toBe('application/x-amz-json-1.1');
        return { status: 200, body: { ChallengeName: 'EMAIL_OTP', Session: 'SESJA-XYZ' } };
      }
      expect(r.body).toEqual({ ChallengeName: 'EMAIL_OTP', ClientId: 'KLIENT1', Session: 'SESJA-XYZ', ChallengeResponses: { USERNAME: 'a@b.pl', EMAIL_OTP_CODE: '123456' } });
      return { status: 200, body: { AuthenticationResult: { AccessToken: TOK.access, IdToken: TOK.id, RefreshToken: TOK.refresh, ExpiresIn: 3600 } } };
    };
    const a = await cli(['zaloguj', '--email', 'a@b.pl']);
    expect(a.json).toEqual({ stan: 'KOD_WYSLANY' });
    expect(statSync(join(kat, 'oczekujace.json')).mode & 0o777).toBe(0o600);
    expect(statSync(kat).mode & 0o777).toBe(0o700);
    const b = await cli(['kod', '--kod', '123456']);
    expect(b.json).toEqual({ stan: 'ZALOGOWANO', osoba: 'a@b.pl', firmy: ['firma1'] });
    expect(statSync(sesjaPlik()).mode & 0o777).toBe(0o600);
    expect(existsSync(join(kat, 'oczekujace.json'))).toBe(false);
    for (const x of [a, b]) for (const t of [...Object.values(TOK), 'SESJA-XYZ']) { expect(x.out).not.toContain(t); expect(x.err).not.toContain(t); }
  });

  it('zly kod -> ZLY_KOD', async () => {
    cogHandler = (r) => op(r) === 'InitiateAuth'
      ? { status: 200, body: { ChallengeName: 'EMAIL_OTP', Session: 'S' } }
      : { status: 400, body: { __type: 'CodeMismatchException' } };
    await cli(['zaloguj', '--email', 'a@b.pl']);
    expect((await cli(['kod', '--kod', '000000'])).json.stan).toBe('ZLY_KOD');
  });

  it('kod bez oczekujacego lub po wygasnieciu -> WYMAGA_LOGOWANIA', async () => {
    expect((await cli(['kod', '--kod', '1'])).json.stan).toBe('WYMAGA_LOGOWANIA');
    mkdirSync(kat, { mode: 0o700 });
    writeFileSync(join(kat, 'oczekujace.json'), JSON.stringify({ email: 'a@b.pl', session: 'S', wygasa: Date.now() - 1000 }), { mode: 0o600 });
    expect((await cli(['kod', '--kod', '1'])).json.stan).toBe('WYMAGA_LOGOWANIA');
  });

  it('wyloguj usuwa pliki, takze gdy nic nie ma', async () => {
    expect((await cli(['wyloguj'])).json).toEqual({ stan: 'WYLOGOWANO' });
    mkdirSync(kat, { mode: 0o700, recursive: true });
    zapiszSesje(Date.now() + 1e6);
    expect((await cli(['wyloguj'])).json.stan).toBe('WYLOGOWANO');
    expect(existsSync(sesjaPlik())).toBe(false);
  });
});

describe('sesja i bezpieczenstwo', () => {
  it('brak sesji -> WYMAGA_LOGOWANIA', async () => {
    expect((await cli(['skrzynka'])).json.stan).toBe('WYMAGA_LOGOWANIA');
    expect(api.log.length).toBe(0);
  });

  it('symlink zamiast sesji -> ODMOWA', async () => {
    mkdirSync(kat, { mode: 0o700 });
    writeFileSync(join(tmp, 'cel.json'), '{}');
    symlinkSync(join(tmp, 'cel.json'), sesjaPlik());
    const r = await cli(['skrzynka']);
    expect(r.json.stan).toBe('ODMOWA');
    expect(api.log.length).toBe(0);
  });

  it('brak konfiguracji -> BRAK_KONFIGURACJI', async () => {
    writeFileSync(konf, JSON.stringify({ adresApi: '', region: '', klientCognito: '', firmaDomyslna: '' }));
    const r = await cli(['skrzynka'], { COGNIFLY_ADRES_API: '' });
    expect(r.json.stan).toBe('BRAK_KONFIGURACJI');
  });

  it('wymusza 600 na istniejacym pliku o luznych prawach', async () => {
    cogHandler = (r) => op(r) === 'InitiateAuth'
      ? { status: 200, body: { ChallengeName: 'EMAIL_OTP', Session: 'S' } }
      : { status: 200, body: { AuthenticationResult: { AccessToken: 'a', IdToken: 'i', RefreshToken: 'r', ExpiresIn: 3600 } } };
    mkdirSync(kat, { mode: 0o700 });
    writeFileSync(sesjaPlik(), '{}', { mode: 0o644 });
    await cli(['zaloguj', '--email', 'a@b.pl']);
    await cli(['kod', '--kod', '1']);
    expect(statSync(sesjaPlik()).mode & 0o777).toBe(0o600);
  });
});

describe('odswiezanie tokenu', () => {
  const refreshOk = (r) => {
    expect(r.body).toEqual({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'KLIENT1', AuthParameters: { REFRESH_TOKEN: TOK.refresh } });
    return { status: 200, body: { AuthenticationResult: { AccessToken: TOK.access2, IdToken: 'ID2', ExpiresIn: 3600 } } };
  };

  it('wygasly token odswiezany raz, API dostaje nowy', async () => {
    mkdirSync(kat, { mode: 0o700 });
    zapiszSesje(Date.now() + 10_000);
    cogHandler = refreshOk;
    apiHandler = () => ({ status: 200, body: { zadania: [] } });
    const r = await cli(['skrzynka']);
    expect(r.json).toEqual({ stan: 'OK', zadania: [] });
    expect(cog.log.length).toBe(1);
    expect(api.log[0].headers.authorization).toBe(`Bearer ${TOK.access2}`);
    expect(api.log[0].headers['x-cognifly-firma']).toBe('firma1');
    const s = JSON.parse(readFileSync(sesjaPlik(), 'utf8'));
    expect(s.accessToken).toBe(TOK.access2);
    expect(s.refreshToken).toBe(TOK.refresh);
    expect(statSync(sesjaPlik()).mode & 0o777).toBe(0o600);
  });

  it('401 z API -> jedno odswiezenie i ponowienie', async () => {
    mkdirSync(kat, { mode: 0o700 });
    zapiszSesje(Date.now() + 3_600_000);
    cogHandler = refreshOk;
    apiHandler = (r) => r.headers.authorization === `Bearer ${TOK.access}` ? { status: 401, body: {} } : { status: 200, body: { zadania: [{ id: 'zad_aaaaaaaaaaaa' }] } };
    const r = await cli(['skrzynka', '--firma', 'inna']);
    expect(r.json.stan).toBe('OK');
    expect(api.log.length).toBe(2);
    expect(cog.log.length).toBe(1);
    expect(api.log[0].headers['x-cognifly-firma']).toBe('inna');
  });

  it('nieudane odswiezenie -> WYMAGA_LOGOWANIA i sesja usunieta', async () => {
    mkdirSync(kat, { mode: 0o700 });
    zapiszSesje(Date.now() - 1000);
    cogHandler = () => ({ status: 400, body: { __type: 'NotAuthorizedException' } });
    const r = await cli(['skrzynka']);
    expect(r.json.stan).toBe('WYMAGA_LOGOWANIA');
    expect(existsSync(sesjaPlik())).toBe(false);
    for (const t of Object.values(TOK)) { expect(r.out).not.toContain(t); expect(r.err).not.toContain(t); }
  });

  it('401 po odswiezeniu -> WYMAGA_LOGOWANIA, bez petli', async () => {
    mkdirSync(kat, { mode: 0o700 });
    zapiszSesje(Date.now() + 3_600_000);
    cogHandler = refreshOk;
    apiHandler = () => ({ status: 401, body: {} });
    const r = await cli(['skrzynka']);
    expect(r.json.stan).toBe('WYMAGA_LOGOWANIA');
    expect(api.log.length).toBe(2);
    expect(cog.log.length).toBe(1);
  });
});

describe('R16', () => {
  beforeEach(() => { mkdirSync(kat, { mode: 0o700 }); });
  it('200 z nie-JSON -> nie OK (API)', async () => {
    zapiszSesje(Date.now() + 3_600_000);
    const s = createServer((q, res) => { res.writeHead(200); res.end('<html>'); });
    await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
    try {
      for (const c of ['skrzynka', 'podsumowanie', 'zdarzenia']) {
        const r = await cli([c], { COGNIFLY_ADRES_API: `http://127.0.0.1:${s.address().port}` });
        expect(r.json).toEqual({ stan: 'BLAD', kod: 'ZLA_ODPOWIEDZ' });
      }
    } finally { s.close(); }
  });
  it('200 z nie-JSON z Cognito przy refresh -> sesja zostaje', async () => {
    zapiszSesje(Date.now() - 1000);
    const s = createServer((q, res) => { res.writeHead(200); res.end('nie json'); });
    await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
    try {
      const r = await cli(['skrzynka'], { COGNIFLY_COGNITO_ENDPOINT: `http://127.0.0.1:${s.address().port}` });
      expect(r.json.stan).toBe('BLAD');
      expect(existsSync(sesjaPlik())).toBe(true);
    } finally { s.close(); }
  });
  it('refresh TooManyRequestsException -> sesja zostaje', async () => {
    zapiszSesje(Date.now() - 1000);
    cogHandler = () => ({ status: 400, body: { __type: 'TooManyRequestsException' } });
    const r = await cli(['skrzynka']);
    expect(r.json).toEqual({ stan: 'BLAD', kod: 'TooManyRequestsException' });
    expect(existsSync(sesjaPlik())).toBe(true);
  });
  it('refresh 500 -> sesja zostaje', async () => {
    zapiszSesje(Date.now() - 1000);
    cogHandler = () => ({ status: 500, body: { __type: 'InternalErrorException' } });
    const r = await cli(['skrzynka']);
    expect(r.json.stan).not.toBe('WYMAGA_LOGOWANIA');
    expect(existsSync(sesjaPlik())).toBe(true);
  });
  it('refresh NotAuthorizedException -> sesja usunieta', async () => {
    zapiszSesje(Date.now() - 1000);
    cogHandler = () => ({ status: 400, body: { __type: 'NotAuthorizedException' } });
    expect((await cli(['skrzynka'])).json.stan).toBe('WYMAGA_LOGOWANIA');
    expect(existsSync(sesjaPlik())).toBe(false);
  });
});

describe('polecenia', () => {
  beforeEach(() => { mkdirSync(kat, { mode: 0o700 }); zapiszSesje(Date.now() + 3_600_000); });

  it('zdarzenia od>do -> ZLY_PRZEDZIAL bez wywolania API', async () => {
    const r = await cli(['zdarzenia', '--od', '2026-11-10', '--do', '2026-11-01']);
    expect(r.json.stan).toBe('ZLY_PRZEDZIAL');
    expect(api.log.length).toBe(0);
  });
  it('zdarzenia > 31 dni i niepoprawna data -> ZLY_PRZEDZIAL lokalnie', async () => {
    expect((await cli(['zdarzenia', '--od', '2026-01-01', '--do', '2026-11-01'])).json.stan).toBe('ZLY_PRZEDZIAL');
    expect((await cli(['zdarzenia', '--od', 'nie-data'])).json.stan).toBe('ZLY_PRZEDZIAL');
    expect((await cli(['zdarzenia', '--ostatnie', '99x'])).json.stan).toBe('ZLY_PRZEDZIAL');
    expect(api.log.length).toBe(0);
  });
  it('zdarzenia --ostatnie 24h woła API z od/do', async () => {
    apiHandler = () => ({ status: 200, body: { zdarzenia: [{ a: 1 }] } });
    const r = await cli(['zdarzenia', '--ostatnie', '24h']);
    expect(r.json).toEqual({ stan: 'OK', zdarzenia: [{ a: 1 }] });
    const u = new URL(api.url + api.log[0].url);
    expect(u.pathname).toBe('/zdarzenia');
    const d = new Date(u.searchParams.get('do')) - new Date(u.searchParams.get('od'));
    expect(d).toBe(86_400_000);
  });
  it('zdarzenia mapuje 400 ZLY_PRZEDZIAL z API', async () => {
    apiHandler = () => ({ status: 400, body: { kod: 'ZLY_PRZEDZIAL' } });
    expect((await cli(['zdarzenia'])).json.stan).toBe('ZLY_PRZEDZIAL');
  });
  it('biore: 200/409/403/404', async () => {
    const id = 'zad_0123456789ab';
    apiHandler = () => ({ status: 200, body: { zadanie: { id } } });
    expect((await cli(['biore', id])).json).toEqual({ stan: 'WZIETE', zadanie: { id } });
    expect(api.log[0].method).toBe('POST');
    expect(api.log[0].url).toBe(`/zadania/${id}/biore`);
    apiHandler = () => ({ status: 409, body: { kod: 'ZAJETE', wlasciciel: 'Jan' } });
    expect((await cli(['biore', id])).json).toEqual({ stan: 'ZAJETE', wlasciciel: 'Jan' });
    apiHandler = () => ({ status: 403, body: {} });
    expect((await cli(['biore', id])).json.stan).toBe('BRAK_DOSTEPU');
    apiHandler = () => ({ status: 404, body: {} });
    expect((await cli(['biore', id])).json.stan).toBe('NIE_ZNALEZIONO');
  });
  it('stan: OK, ZLY_STAN lokalnie, postep przekazany', async () => {
    const id = 'zad_0123456789abcdef01234567';
    apiHandler = () => ({ status: 200, body: { zadanie: { id } } });
    const r = await cli(['stan', id, 'w_trakcie', '--postep', 'polowa']);
    expect(r.json).toEqual({ stan: 'OK', zadanie: { id } });
    expect(api.log[0].body).toEqual({ stan: 'w_trakcie', postep: 'polowa' });
    api.log.length = 0;
    expect((await cli(['stan', id, 'cokolwiek'])).json.stan).toBe('ZLY_STAN');
    expect(api.log.length).toBe(0);
  });
  it('podsumowanie -> OK linia; inny blad HTTP -> BLAD kod', async () => {
    apiHandler = () => ({ status: 200, body: { linia: 'Czeka 5 zadan' } });
    expect((await cli(['podsumowanie'])).json).toEqual({ stan: 'OK', linia: 'Czeka 5 zadan' });
    apiHandler = () => ({ status: 500, body: { kod: 'WEWNETRZNY' } });
    expect((await cli(['podsumowanie'])).json).toEqual({ stan: 'BLAD', kod: 'WEWNETRZNY' });
  });
  it('siec niedostepna -> BLAD_SIECI', async () => {
    const r = await cli(['skrzynka'], { COGNIFLY_ADRES_API: 'http://127.0.0.1:1' });
    expect(r.json.stan).toBe('BLAD_SIECI');
    expect(r.code).toBe(0);
  });
  it('zadne wyjscie nie zawiera tokenow', async () => {
    apiHandler = () => ({ status: 500, body: { kod: 'X' } });
    const r = await cli(['skrzynka']);
    for (const t of Object.values(TOK)) { expect(r.out).not.toContain(t); expect(r.err).not.toContain(t); }
  });
  it('nieznane polecenie -> BLAD, JSON na stdout', async () => {
    const r = await cli(['cos']);
    expect(r.json.stan).toBe('BLAD');
  });
});
