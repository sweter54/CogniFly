// Wywołania API CogniFly i polecenia CLI. Bez zależności.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Stan, katalog, czytaj, punktCognito, odswiez, zaloguj, kod, wyloguj } from './sesja.mjs';

const DOBA = 86_400_000;
const STANY = ['w_trakcie', 'do_akceptacji', 'zrobione'];
const ID_ZADANIA = /^zad_([0-9a-f]{12}|[0-9a-f]{24})$/;
const DOMYSLNA_KONF = fileURLToPath(new URL('../../konfiguracja.json', import.meta.url));

export function wczytajKonfiguracje(env = process.env) {
  let k = {};
  try { k = JSON.parse(readFileSync(env.COGNIFLY_KONFIGURACJA || DOMYSLNA_KONF, 'utf8')); } catch {}
  return {
    adresApi: env.COGNIFLY_ADRES_API || k.adresApi || '',
    region: k.region || '',
    klientCognito: k.klientCognito || '',
    firmaDomyslna: k.firmaDomyslna || '',
  };
}

export function parsuj(argv) {
  const poz = [], opcje = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opcje[argv[i].slice(2)] = argv[i + 1]; i++; } else poz.push(argv[i]);
  }
  return { poz, opcje };
}

function data(v) {
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v ?? '')) throw new Stan('ZLY_PRZEDZIAL');
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Stan('ZLY_PRZEDZIAL');
  return d;
}

export function przedzial(opcje, teraz = new Date()) {
  let od, doC;
  if (opcje.od !== undefined || opcje.do !== undefined) {
    doC = opcje.do !== undefined ? data(opcje.do) : teraz;
    od = opcje.od !== undefined ? data(opcje.od) : new Date(doC.getTime() - DOBA);
  } else {
    const m = /^(\d{1,4})([hd])$/.exec(opcje.ostatnie ?? '24h');
    if (!m) throw new Stan('ZLY_PRZEDZIAL');
    doC = teraz;
    od = new Date(teraz.getTime() - Number(m[1]) * (m[2] === 'h' ? 3_600_000 : DOBA));
  }
  if (od.getTime() > doC.getTime() || doC.getTime() - od.getTime() > 31 * DOBA) throw new Stan('ZLY_PRZEDZIAL');
  return { od: od.toISOString(), do: doC.toISOString() };
}

async function wywolaj(url, metoda, sesja, firma, body, signal) {
  const naglowki = { Authorization: `Bearer ${sesja.accessToken}` };
  if (firma) naglowki['X-Cognifly-Firma'] = firma;
  if (body !== undefined) naglowki['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(url, { method: metoda, headers: naglowki, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch { throw new Stan('BLAD_SIECI'); }
  let json = {};
  try { json = await r.json(); } catch {
    if (r.status >= 200 && r.status < 300) throw new Stan(signal?.aborted ? 'BLAD_SIECI' : 'BLAD', signal?.aborted ? {} : { kod: 'ZLA_ODPOWIEDZ' });
  }
  return { status: r.status, json };
}

// Wywołanie z sesją: odświeżenie przy bliskim wygaśnięciu lub 401 (maks. raz).
async function zSesja(ctx, metoda, sciezka, body) {
  const sesja0 = czytaj(ctx.kat, 'sesja.json');
  if (!sesja0 || !sesja0.accessToken || !sesja0.refreshToken) throw new Stan('WYMAGA_LOGOWANIA');
  let sesja = sesja0, odswiezono = false;
  const dane = { kat: ctx.kat, konf: ctx.konf, endpoint: ctx.endpoint, signal: ctx.signal };
  if (!(sesja.wygasa - Date.now() > 60_000)) { sesja = await odswiez({ ...dane, sesja }); odswiezono = true; }
  const url = ctx.konf.adresApi.replace(/\/+$/, '') + sciezka;
  const firma = ctx.opcje.firma || ctx.konf.firmaDomyslna;
  let r = await wywolaj(url, metoda, sesja, firma, body, ctx.signal);
  if (r.status === 401) {
    if (odswiezono) throw new Stan('WYMAGA_LOGOWANIA');
    sesja = await odswiez({ ...dane, sesja });
    r = await wywolaj(url, metoda, sesja, firma, body, ctx.signal);
    if (r.status === 401) throw new Stan('WYMAGA_LOGOWANIA');
  }
  return r;
}

const blad = (r) => ({ stan: 'BLAD', kod: typeof r.json?.kod === 'string' ? r.json.kod : `HTTP_${r.status}` });

export async function wykonaj(argv, env = process.env) {
  const { poz, opcje } = parsuj(argv);
  const polecenie = poz[0];
  const kat = katalog(env);
  try {
    if (polecenie === 'wyloguj') return wyloguj(kat);
    const komendy = ['zaloguj', 'kod', 'zdarzenia', 'skrzynka', 'biore', 'stan', 'podsumowanie'];
    if (!komendy.includes(polecenie)) throw new Stan('BLAD', { kod: 'NIEZNANE_POLECENIE' });

    // walidacje lokalne przed siecią i konfiguracją
    let zapytanie = '', id;
    if (polecenie === 'zdarzenia') {
      const p = przedzial(opcje);
      const q = new URLSearchParams(p);
      if (opcje.zrodlo) q.set('zrodlo', opcje.zrodlo);
      if (opcje.typ) q.set('typ', opcje.typ);
      zapytanie = `?${q}`;
    }
    if (polecenie === 'biore' || polecenie === 'stan') {
      id = poz[1];
      if (!ID_ZADANIA.test(id ?? '')) throw new Stan('NIE_ZNALEZIONO');
    }
    if (polecenie === 'stan' && !STANY.includes(poz[2])) throw new Stan('ZLY_STAN');

    const konf = wczytajKonfiguracje(env);
    if (!konf.adresApi || !konf.klientCognito) throw new Stan('BRAK_KONFIGURACJI');
    const endpoint = punktCognito(konf, env);
    const signal = AbortSignal.timeout(polecenie === 'podsumowanie' ? 1200 : 10_000);
    const ctx = { kat, konf, endpoint, signal, opcje };

    switch (polecenie) {
      case 'zaloguj': return await zaloguj({ ...ctx, email: opcje.email });
      case 'kod': return await kod({ ...ctx, kod: opcje.kod });
      case 'zdarzenia': {
        const r = await zSesja(ctx, 'GET', `/zdarzenia${zapytanie}`);
        if (r.status === 200) return { stan: 'OK', zdarzenia: r.json.zdarzenia ?? [] };
        if (r.status === 400 && r.json?.kod === 'ZLY_PRZEDZIAL') return { stan: 'ZLY_PRZEDZIAL' };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        return blad(r);
      }
      case 'skrzynka': {
        const r = await zSesja(ctx, 'GET', '/skrzynka');
        if (r.status === 200) return { stan: 'OK', zadania: r.json.zadania ?? [] };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        return blad(r);
      }
      case 'biore': {
        const r = await zSesja(ctx, 'POST', `/zadania/${id}/biore`);
        if (r.status === 200) return { stan: 'WZIETE', zadanie: r.json.zadanie };
        if (r.status === 409) return { stan: 'ZAJETE', wlasciciel: r.json.wlasciciel };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        if (r.status === 404) return { stan: 'NIE_ZNALEZIONO' };
        return blad(r);
      }
      case 'stan': {
        const body = { stan: poz[2], ...(opcje.postep !== undefined ? { postep: opcje.postep } : {}) };
        const r = await zSesja(ctx, 'POST', `/zadania/${id}/stan`, body);
        if (r.status === 200) return { stan: 'OK', zadanie: r.json.zadanie };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        if (r.status === 404) return { stan: 'NIE_ZNALEZIONO' };
        return blad(r);
      }
      case 'podsumowanie': {
        const r = await zSesja(ctx, 'GET', '/podsumowanie');
        if (r.status === 200) return { stan: 'OK', linia: String(r.json.linia ?? '') };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        return blad(r);
      }
    }
  } catch (e) {
    if (e instanceof Stan) return { stan: e.stan, ...e.dane };
    return { stan: 'BLAD', kod: 'NIEOCZEKIWANY' };
  }
}
