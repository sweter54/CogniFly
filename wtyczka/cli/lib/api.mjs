// Wywołania API CogniFly i polecenia CLI. Bez zależności.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Stan, katalog, czytaj, zapisz, punktCognito, odswiez, zaloguj, kod, wyloguj } from './sesja.mjs';

const DOBA = 86_400_000;
const STANY = ['w_trakcie', 'do_akceptacji', 'zrobione'];
const ID_ZADANIA = /^zad_([0-9a-f]{12}|[0-9a-f]{24})$/;
const LOGIN_GITHUB = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const REPO = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const DOMYSLNA_KONF = fileURLToPath(new URL('../../konfiguracja.json', import.meta.url));

// Kolejność: zmienne środowiskowe > konfiguracja wtyczki > <katalog>/konfiguracja.json (~/.cognifly) > domyślne.
// Plik w katalogu użytkownika podlega tym samym zasadom (lstat, odmowa dla symlinków) co pozostałe pliki sesji.
export function wczytajKonfiguracje(env = process.env) {
  let k = {};
  try { k = JSON.parse(readFileSync(env.COGNIFLY_KONFIGURACJA || DOMYSLNA_KONF, 'utf8')); } catch {}
  const pole = (v) => (typeof v === 'string' ? v.trim() : '');
  const wtyczki = { adresApi: pole(k.adresApi), region: pole(k.region), klientCognito: pole(k.klientCognito), firmaDomyslna: pole(k.firmaDomyslna) };
  const zEnv = { adresApi: pole(env.COGNIFLY_ADRES_API), region: pole(env.COGNIFLY_REGION), klientCognito: pole(env.COGNIFLY_KLIENT), firmaDomyslna: pole(env.COGNIFLY_FIRMA) };
  let u = {};
  if (Object.keys(wtyczki).some((n) => !zEnv[n] && !wtyczki[n])) {
    const z = czytaj(katalog(env), 'konfiguracja.json');
    if (z && typeof z === 'object') u = z;
  }
  return {
    adresApi: pole(env.COGNIFLY_ADRES_API) || wtyczki.adresApi || pole(u.adresApi),
    region: pole(env.COGNIFLY_REGION) || wtyczki.region || pole(u.region) || 'eu-central-1',
    klientCognito: pole(env.COGNIFLY_KLIENT) || wtyczki.klientCognito || pole(u.klientCognito),
    firmaDomyslna: pole(env.COGNIFLY_FIRMA) || wtyczki.firmaDomyslna || pole(u.firmaDomyslna),
  };
}

function konfiguruj(kat, opcje) {
  const adres = opcje['adres-api'], klient = opcje.klient, region = opcje.region ?? 'eu-central-1', firma = opcje.firma ?? '';
  if (typeof adres !== 'string' || !/^https?:\/\/[^\s]+$/.test(adres) || typeof klient !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(klient)
    || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region) || !/^[a-z0-9-]{0,40}$/.test(firma)) {
    throw new Stan('BLAD', { kod: 'ZLE_PARAMETRY_KONFIGURACJI' });
  }
  zapisz(kat, 'konfiguracja.json', { adresApi: adres.replace(/\/+$/, ''), region, klientCognito: klient, firmaDomyslna: firma });
  return { stan: 'KONFIGURACJA_ZAPISANA' };
}

const FLAGI = ['dane']; // opcje bez wartości

export function parsuj(argv) {
  const poz = [], opcje = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const n = argv[i].slice(2);
      if (FLAGI.includes(n)) opcje[n] = true; else { opcje[n] = argv[i + 1]; i++; }
    } else poz.push(argv[i]);
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

// Domyślnie bez treści pochodzącej od obcych (`dane`, nazwa gałęzi); pełny obiekt tylko z --dane.
function odchudz(z) {
  if (!z || typeof z !== 'object') return z;
  const { dane, podmiot, ...reszta } = z; // eslint-disable-line no-unused-vars
  const wynik = {};
  for (const k of ['id', 'czas', 'typ', 'zrodlo', 'opis']) if (k in reszta) wynik[k] = reszta[k];
  if (podmiot && typeof podmiot === 'object') { const { galaz, ...p } = podmiot; wynik.podmiot = p; } // eslint-disable-line no-unused-vars
  if ('wymagaPracy' in reszta) wynik.wymagaPracy = reszta.wymagaPracy;
  return wynik;
}

// Po zmianie zadania pokaż je w aplikacji CogniFly (link cognifly://, tylko id zadania).
// macOS: /usr/bin/open; COGNIFLY_OTWIERACZ podmienia program ('' = wyłączone). Błąd lub brak aplikacji = cisza.
export function pokazWAplikacji(id, env = process.env) {
  const otwieracz = env.COGNIFLY_OTWIERACZ ?? (process.platform === 'darwin' ? '/usr/bin/open' : '');
  if (!otwieracz || !ID_ZADANIA.test(id)) return Promise.resolve();
  return new Promise((ok) => {
    execFile(otwieracz, [`cognifly://zadanie/${id}`], { timeout: 3000 }, () => ok());
  });
}

const blad = (r) => ({ stan: 'BLAD', kod: typeof r.json?.kod === 'string' ? r.json.kod : `HTTP_${r.status}` });

export async function wykonaj(argv, env = process.env) {
  const { poz, opcje } = parsuj(argv);
  const polecenie = poz[0];
  const kat = katalog(env);
  try {
    if (polecenie === 'wyloguj') return wyloguj(kat);
    if (polecenie === 'konfiguruj') return konfiguruj(kat, opcje);
    const komendy = ['zaloguj', 'kod', 'zdarzenia', 'skrzynka', 'zadanie', 'biore', 'stan', 'przekaz', 'ocena-dostarczenia', 'dostarczenie', 'osoby', 'zglos-cr', 'podsumowanie'];
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
    if (['zadanie', 'biore', 'stan', 'przekaz'].includes(polecenie)) {
      id = poz[1];
      if (!ID_ZADANIA.test(id ?? '')) throw new Stan('NIE_ZNALEZIONO');
    }
    if (polecenie === 'stan' && !STANY.includes(poz[2])) throw new Stan('ZLY_STAN');
    if (polecenie === 'przekaz' && !LOGIN_GITHUB.test(opcje['do-loginu'] ?? '')) throw new Stan('ZLY_LOGIN');
    let dostawa;
    let recenzenci;
    if (polecenie === 'zglos-cr') {
      recenzenci = String(opcje.recenzenci ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!recenzenci.length || !recenzenci.every((x) => /^[A-Za-z0-9._-]{1,64}$/.test(x))) throw new Stan('ZLE_PARAMETRY');
    }
    if (['ocena-dostarczenia', 'dostarczenie', 'zglos-cr'].includes(polecenie)) {
      dostawa = { repo: opcje.repo, pr: Number(opcje.pr) };
      const zle = typeof dostawa.repo !== 'string' || !REPO.test(dostawa.repo) || dostawa.repo.split('/').includes('..')
        || !Number.isInteger(dostawa.pr) || dostawa.pr < 1
        || (polecenie === 'dostarczenie' && (!ID_ZADANIA.test(opcje.zadanie ?? '') || !SHA.test(opcje.sha ?? '')));
      if (zle) throw new Stan('ZLE_PARAMETRY');
    }

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
        if (r.status === 200) {
          const lista = Array.isArray(r.json.zdarzenia) ? r.json.zdarzenia : [];
          return { stan: 'OK', zdarzenia: opcje.dane === true ? lista : lista.map(odchudz) };
        }
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
      case 'zadanie': {
        // Zdarzenie odchudzane także tutaj (obrona w głąb): bez `dane` i nazwy gałęzi.
        const r = await zSesja(ctx, 'GET', `/zadania/${id}`);
        if (r.status === 200) return { stan: 'OK', zadanie: r.json.zadanie, zdarzenie: r.json.zdarzenie ? odchudz(r.json.zdarzenie) : null };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        if (r.status === 404) return { stan: 'NIE_ZNALEZIONO' };
        return blad(r);
      }
      case 'biore': {
        const r = await zSesja(ctx, 'POST', `/zadania/${id}/biore`);
        if (r.status === 200) {
          await pokazWAplikacji(id, env);
          return { stan: 'WZIETE', zadanie: r.json.zadanie };
        }
        if (r.status === 409) return { stan: 'ZAJETE', wlasciciel: r.json.wlasciciel };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        if (r.status === 404) return { stan: 'NIE_ZNALEZIONO' };
        return blad(r);
      }
      case 'stan': {
        const body = { stan: poz[2], ...(opcje.postep !== undefined ? { postep: opcje.postep } : {}) };
        const r = await zSesja(ctx, 'POST', `/zadania/${id}/stan`, body);
        if (r.status === 200) {
          await pokazWAplikacji(id, env);
          return { stan: 'OK', zadanie: r.json.zadanie };
        }
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        if (r.status === 404) return { stan: 'NIE_ZNALEZIONO' };
        return blad(r);
      }
      case 'przekaz': {
        const r = await zSesja(ctx, 'POST', `/zadania/${id}/przekaz`, { doLoginu: opcje['do-loginu'] });
        if (r.status === 200) return { stan: 'PRZEKAZANE', zadanie: r.json.zadanie };
        if (r.status === 409 && r.json?.kod === 'BRAK_OSOBY') return { stan: 'BRAK_OSOBY' };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        if (r.status === 404) return { stan: 'NIE_ZNALEZIONO' };
        return blad(r);
      }
      case 'ocena-dostarczenia': {
        const q = new URLSearchParams({ repo: dostawa.repo, pr: String(dostawa.pr) });
        const r = await zSesja(ctx, 'GET', `/dostarczenia/ocena?${q}`);
        if (r.status === 200) return { stan: 'OK', ocena: r.json.ocena };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        return blad(r);
      }
      case 'dostarczenie': {
        const r = await zSesja(ctx, 'POST', '/dostarczenia', { ...dostawa, zadanieId: opcje.zadanie, sha: opcje.sha });
        if (r.status === 200) return { stan: 'NASLUCH', ocena: r.json.ocena };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        if (r.status === 404) return { stan: 'NIE_ZNALEZIONO' };
        return blad(r);
      }
      case 'osoby': {
        const r = await zSesja(ctx, 'GET', '/osoby');
        if (r.status === 200) return { stan: 'OK', osoby: Array.isArray(r.json.osoby) ? r.json.osoby : [] };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
        return blad(r);
      }
      case 'zglos-cr': {
        const r = await zSesja(ctx, 'POST', '/recenzje', { ...dostawa, recenzenci });
        if (r.status === 200) return { stan: 'ZGLOSZONO', zadanie: r.json.zadanie };
        if (['ZLI_RECENZENCI', 'BRAK_PR', 'PR_ZAMKNIETY'].includes(r.json?.kod)) return { stan: r.json.kod };
        if (r.status === 403) return { stan: 'BRAK_DOSTEPU' };
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
