# CogniFly — aplikacja na Maca (Tauri v2), v1 — projekt skrócony

Zaakceptowany przez Michała 2026-11-16. Uzupełnia projekt główny (`2026-11-16-cognifly-design.md`, 6.7 pkt 2, 6.9, 6.10).

## Po co
Osoba nietechniczna ma widzieć przy zegarze, ile zadań na nią czeka, i dostać dymek systemowy, gdy pojawi się
nowe zadanie albo eskalacja — bez Claude'a, bez terminala, bez Node.

## Cele / nie-cele / anty-cele
- **Cele v1 (tylko macOS):** okno konfiguracji (adres API, klient Cognito, region, firma — wstępnie wypełnione
  wartościami pilota), logowanie e-mail → kod z maila (Cognito `USER_AUTH` + `EMAIL_OTP`), tokeny w Pęku kluczy,
  ciche odświeżanie, wylogowanie; ikona w pasku menu z licznikiem; dymki dla nowych zadań/eskalacji
  (odpytywanie co 60 s, deduplikacja); okno skrzynki z „biorę” (obsługa `ZAJETE`) i zmianą stanu.
- **Nie-cele v1:** WebSocket, Windows, podpis/notaryzacja, aktualizator (klucze później), instalator z linkiem.
- **Anty-cele:** tokeny w plikach lub w logach; treść od obcych (tytuły PR itp.) w dymku; wylogowanie z powodu
  braku sieci; logika biznesowa w Ruście; zależność od Node/CLI w działającej aplikacji.

## Rozważone podejścia
1. **`fetch` z webview** — odpada: CORS API przepuszcza tylko `authorization`, `content-type`; nagłówek
   `X-Cognifly-Firma` blokowany przez preflight (wymagałby zmiany infrastruktury).
2. **Oficjalna wtyczka `tauri-plugin-http`** (wybrane) — zapytania wykonuje warstwa Rust, bez CORS; zakres URL
   ograniczony w uprawnieniach do `https://*.execute-api.*.amazonaws.com/*` i `https://cognito-idp.*.amazonaws.com/`.
   Koszt: własna domena API wymaga przebudowy z rozszerzonym zakresem.
3. **Logika w Ruście** — odpada (decyzja: Rust tylko jako cienka warstwa).

## Projekt
- **UI:** TypeScript + Vite, bez frameworka. Workspace `aplikacja/` (npm), Rust w `aplikacja/src-tauri/`.
- **Kontrakt:** `wspolne/src/api.ts` — czyste typy (`Zadanie`, `StanZadania`, odpowiedzi API), eksport
  `@cognifly/wspolne/api` bez `node:crypto`; serwer importuje te typy stamtąd.
- **Okna:** ukryte `tlo` jest jedynym właścicielem sesji: tokeny (Pęk kluczy), HTTP, powiadomienia, ikona,
  odpytywanie. Okna `konfiguracja`, `logowanie`, `skrzynka` mają wyłącznie uprawnienia zdarzeń (+ zamknięcie
  własnego okna) i proszą `tlo` o akcje przez zdarzenia Tauri. Uprawnienia per okno w `capabilities/`.
- **Pęk kluczy:** crate `keyring` (macOS Keychain), trzy komendy Rust: zapisz/czytaj/usuń **jednego stałego
  wpisu** (`serwis = pl.cognifly.aplikacja`, `konto = sesja`). Dostępne tylko dla okna `tlo`.
- **Konfiguracja:** `localStorage` (dane jawne), domyślne wartości pilota wkompilowane; walidacja jak w CLI.
- **Sesja:** odświeżenie, gdy do wygaśnięcia < 60 s lub po 401 (maks. raz). Wylogowanie wyłącznie przy
  `NotAuthorizedException`/`UserNotFoundException` podczas odświeżania; sieć/timeout → stan „offline”, sesja zostaje.
- **Powiadomienia:** klucz deduplikacji `id#stan` dla stanów `nowe` i `eskalowane`; zbiór widzianych kluczy
  w `localStorage`; pierwsze odpytanie po instalacji tylko zapamiętuje (bez dymków). Treść: tytuł „CogniFly”,
  ciało = `opis` z serwera (oczyszczony, przycięty). Licznik = liczba zadań `nowe|eskalowane`.
- **Kliknięcie dymku:** `onAction` z wtyczki powiadomień (na desktopie `actionId = "tap"`, od 2.8) → okno skrzynki.
- **Bezpieczeństwo:** ścisłe CSP (`default-src 'self'`, bez `unsafe-inline` dla skryptów), brak shell/fs,
  tokeny nigdy w logach ani w zdarzeniach do innych okien.

## Zmiany po testach z Michałem (2026-11-16)
- **Jedno okno główne** `main` zamiast trzech (logowanie / skrzynka / ustawienia): prowadzone logowanie
  krokami (e-mail → kod → gotowe), skrzynka i ustawienia w zakładkach. Okno `main` ma tylko uprawnienia
  zdarzeń, ukrycia i logu.
- **Dock i Cmd+Tab:** gdy okno jest otwarte, aplikacja jest zwykłą aplikacją (ikona w Docku, Cmd+Tab);
  po zamknięciu okna wraca do samej ikony przy zegarze. Klik w Dock / ponowne uruchomienie → okno.
- **Ikona przy zegarze:** lewy klik otwiera okno, prawy — menu; dokładnie jedna ikona (usuwana po przeładowaniu).
- **Jedna instancja:** `tauri-plugin-single-instance`.
- **Odpytywanie w tle:** okno `background` ma `backgroundThrottling: disabled`, a pakiet `NSAppSleepDisabled`
  — bez tego macOS usypiał ukryte okno i odpytywanie stawało (dymki ginęły).
- **Diagnostyka:** `tauri-plugin-log` (stdout + `~/Library/Logs/pl.cognifly.aplikacja/`): błędy okien, HTTP
  (tylko host), RPC (kody), wynik każdego odpytania (liczby, bez treści).
- **Rust** poza wtyczkami: komendy Pęku kluczy, ukrywanie okna, Dock (polityka aktywacji), `Reopen`.

## Zostawione budowniczemu
Ikony, wygląd okien, nazwy zdarzeń, podział plików TS. Propozycja (nie w v1): prefiks wersji API `/v1` i
nagłówek minimalnej wersji klienta.
