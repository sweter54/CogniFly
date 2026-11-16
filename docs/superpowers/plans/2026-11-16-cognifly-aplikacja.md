# CogniFly — aplikacja Tauri v1 (macOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikacja w pasku menu macOS: licznik czekających zadań, dymki dla nowych zadań/eskalacji, skrzynka z „biorę”, logowanie kodem z maila, tokeny w Pęku kluczy.

**Architecture:** Tauri v2; Rust tylko jako cienka warstwa (oficjalne wtyczki + 3 komendy `keyring`). Cała logika w TS: czyste moduły w `aplikacja/src/logika/` (testowane vitest, zależności wstrzykiwane), okna w `aplikacja/src/okna/`. Ukryte okno `tlo` jest jedynym właścicielem sesji i sieci; pozostałe okna rozmawiają z nim zdarzeniami.

**Tech Stack:** Tauri 2.12, `@tauri-apps/api`, `@tauri-apps/plugin-http` 2.9, `@tauri-apps/plugin-notification` 2.8, crate `keyring` 4, Vite, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-cognifly-aplikacja-design.md` (+ projekt główny 6.7, 6.9, 6.10)

## Global Constraints

- macOS only w v1; identyfikator `pl.cognifly.aplikacja`.
- Tokeny wyłącznie w Pęku kluczy (`serwis = pl.cognifly.aplikacja`, `konto = sesja`); nigdy w `localStorage`, logach, zdarzeniach między oknami.
- Treść dymku wyłącznie z `opis` serwera; nigdy inne pola zadania/zdarzenia.
- Wylogowanie tylko przy `NotAuthorizedException`/`UserNotFoundException` podczas odświeżania; sieć/timeout → „offline”.
- Odświeżenie tokenu, gdy do wygaśnięcia ≤ 60 s albo po 401 (maks. raz na wywołanie).
- Odpytywanie co 60 s; timeout zapytania 10 s.
- Uprawnienia per okno minimalne; CSP `default-src 'self'`, bez `unsafe-inline`/`eval` w skryptach; brak shell/fs.
- Zakres HTTP: `https://*.execute-api.*.amazonaws.com/*`, `https://cognito-idp.*.amazonaws.com/`.
- Wartości domyślne pilota: API `https://td5k44easl.execute-api.eu-central-1.amazonaws.com`, klient `67b7re8ou041svoosk3ukotqrq`, region `eu-central-1`, firma `pilot`.
- `npm test` w katalogu głównym zielony.

## Review Focus

1. Sieć pada w trakcie odświeżania → sesja zostaje, ikona pokazuje „offline”, brak wylogowania. Test w Task 3 (`sesja.test.ts`).
2. To samo zadanie wraca w kolejnych odpytaniach → jeden dymek; to samo zadanie przechodzi w `eskalowane` → drugi dymek. Test w Task 3 (`powiadomienia.test.ts`).
3. Pierwsze uruchomienie z 10 starymi zadaniami → zero dymków, licznik 10. Test w Task 3.
4. `opis` z nowymi liniami/ogromny → dymek jednolinijkowy, ≤ 200 znaków. Test w Task 3.
5. Dwie osoby klikają „biorę” → przegrany widzi „zajęte przez <osoba>”, lista się odświeża. Test w Task 3 (`api.test.ts`, 409 → `ZAJETE`).

---

### Task 1: Kontrakt API w `wspolne`

**Files:** Create `wspolne/src/api.ts`; Modify `wspolne/package.json` (export `./api`), `serwer/src/dane/kolejka.ts` (typy importowane z `@cognifly/wspolne/api`).

**Produces:** `StanZadania`, `Zadanie`, `Eskalacja`, `OdpowiedzSkrzynka = {zadania: Zadanie[]}`, `OdpowiedzZadanie = {zadanie: Zadanie}`, `OdpowiedzZajete = {kod:'ZAJETE', wlasciciel:string}`, `STANY_UZYTKOWNIKA = ['w_trakcie','do_akceptacji','zrobione']`. Plik bez importów z Node.

- [ ] Przenieś typy, uruchom `npx tsc -p serwer --noEmit` i `npm test` → zielone. Commit.

### Task 2: Szkielet `aplikacja/` + warstwa Rust

**Files:** `aplikacja/package.json`, `vite.config.ts`, `tsconfig.json`, `index`-y HTML okien (`tlo.html`, `konfiguracja.html`, `logowanie.html`, `skrzynka.html`), `src-tauri/{Cargo.toml,tauri.conf.json,build.rs,src/main.rs,src/lib.rs,capabilities/*.json,icons/*}`; root `package.json` (workspace), `vitest.workspace.ts`, `.gitignore` (`aplikacja/src-tauri/target`, `aplikacja/dist`).

- `lib.rs`: wtyczki `http`, `notification`; `ActivationPolicy::Accessory`; komendy `sejf_zapisz(wartosc: String)`, `sejf_czytaj() -> Option<String>`, `sejf_usun()` na stałym wpisie keyring; zamknięcie okna = ukrycie (nie kończy aplikacji).
- `tauri.conf.json`: okno `tlo` niewidoczne; pozostałe tworzone z TS na żądanie (lub zadeklarowane `visible:false`); CSP jak w Global Constraints; `withGlobalTauri: false`.
- Capabilities: `tlo.json` (okno `tlo`: core event/window/webview/tray/menu/image, http z zakresem, notification, komendy sejfu), `ui.json` (okna `konfiguracja`,`logowanie`,`skrzynka`: tylko `core:event:default`, `core:window:allow-close`, `core:window:allow-hide`).
- [ ] `npx tauri build --debug --no-bundle` (z `aplikacja/`) kompiluje się. Commit.

### Task 3: Logika TS (testowana)

**Files:** `aplikacja/src/logika/{konfiguracja,cognito,sesja,api,powiadomienia,bledy}.ts`, testy w `aplikacja/test/`.

**Produces:**
- `bledy.ts`: `class BladSieci`, `class WymagaLogowania`, `class BladCognito {kod}`, `class BladApi {status, kod}`.
- `konfiguracja.ts`: `type Konfiguracja = {adresApi, region, klientCognito, firma}`, `DOMYSLNA`, `zwaliduj(x): {ok:true,konf}|{ok:false,pole}` (reguły jak `konfiguruj` w `wtyczka/cli/lib/api.mjs`, plus adres tylko `https://`), `wczytaj(m: Magazyn)`, `zapisz(m, k)`; `Magazyn = Pick<Storage,'getItem'|'setItem'|'removeItem'>`.
- `cognito.ts`: `type Pobierz = (url: string, init: RequestInit) => Promise<Response>`; `wyslijKod(k, email, pobierz) -> {session}`, `potwierdzKod(k, {email, session, kod}, pobierz) -> Sesja`, `odswiez(k, refresh, pobierz) -> Sesja`; kształty żądań jak `wtyczka/cli/lib/sesja.mjs`; `CodeMismatch/ExpiredCode → BladCognito('ZLY_KOD')`.
- `sesja.ts`: `type Sesja = {accessToken, refreshToken, wygasa}`; `interface Sejf {czytaj(): Promise<string|null>; zapisz(s): Promise<void>; usun(): Promise<void>}`; `class MenedzerSesji(sejf, odswiezFn, teraz)` z `token(): Promise<string>`, `wymusOdswiezenie(): Promise<string>`, `ustaw(s)`, `wyloguj()`, `zalogowany(): Promise<boolean>`; współbieżne odświeżenia łączone w jedno.
- `api.ts`: `class KlientApi(konf, menedzer, pobierz)`: `skrzynka(): Promise<Zadanie[]>`, `biore(id): Promise<{stan:'WZIETE',zadanie}|{stan:'ZAJETE',wlasciciel}>`, `zmienStan(id, stan): Promise<Zadanie>`; nagłówki `Authorization`, `X-Cognifly-Firma`; 401 → `wymusOdswiezenie` i jedna ponowna próba, potem `WymagaLogowania`; walidacja id `^zad_([0-9a-f]{12}|[0-9a-f]{24})$` przed siecią.
- `powiadomienia.ts`: `czekajace(z: Zadanie[])` (stan `nowe|eskalowane`), `wybierzNowe(z, widziane: Set<string>|null) -> {nowe: Zadanie[], widziane: Set<string>}` (klucz `id#stan`; `null` = pierwsze uruchomienie → `nowe=[]`), `tekstDymku(opis) -> string` (białe znaki → spacja, ≤ 200 znaków z `…`).

Testy (kluczowe asercje): odświeżenie przy ≤ 60 s; `BladSieci` przy odświeżaniu nie czyści sejfu; `NotAuthorizedException` czyści sejf i rzuca `WymagaLogowania`; 401→odśwież→200; 401 dwa razy → `WymagaLogowania`; 409 → `ZAJETE` z właścicielem; zły id → brak wywołania sieci; deduplikacja z Review Focus 2–4; walidacja konfiguracji odrzuca `http://`.
- [ ] TDD per moduł; `npm test` zielony. Commit.

### Task 4: Okna i ikona

**Files:** `aplikacja/src/okna/{tlo,konfiguracja,logowanie,skrzynka}.ts`, `aplikacja/src/okna/zdarzenia.ts` (nazwy zdarzeń i typy ładunków), `aplikacja/src/styl.css`.

- `tlo.ts`: buduje `KlientApi` z `fetch` wtyczki http i `Sejf` przez `invoke`; ikona `TrayIcon` z tytułem = licznik (pusty przy 0, „!” offline), menu: Otwórz skrzynkę / Odśwież / Ustawienia / Wyloguj (lub Zaloguj) / Zakończ; pętla 60 s; dymki przez `sendNotification`; `onAction` → pokaż `skrzynka`; obsługuje żądania okien: `logowanie:wyslij-kod`, `logowanie:kod`, `skrzynka:pobierz`, `skrzynka:biore`, `skrzynka:stan`, `konfiguracja:zapisano` → odpowiada zdarzeniami do konkretnego okna (`emitTo`). Bez sesji przy starcie → okno `logowanie`.
- Okna UI: wyłącznie DOM + `emit/listen`; tekst wstawiany przez `textContent` (nigdy `innerHTML`).
- [ ] `npm run tauri dev` startuje, ikona widoczna. Commit.

### Task 5: Weryfikacja na żywo

- [ ] Logowanie na pilocie (kod z maila od Michała — sprawdzić spam).
- [ ] Za zgodą Michała: komentarz recenzji w sweter54/CogniFly#1 → zadanie dla `michal` → dymek + licznik; zrzut ekranu.
- [ ] Raport: co zweryfikowane, co nie, decyzje.
