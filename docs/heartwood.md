# Adapter Heartwood

CogniFly łączy zadania z plikami Heartwood (wersje, blokady, konflikty). Serwer
mówi Heartwoodowi, kto pisze w danej pracy, a Heartwood odsyła zdarzenia, które
stają się zadaniami i powiadomieniami. Aplikacja uruchamia klienta (demona)
Heartwood i pokazuje zakładkę „Pliki”.

## Jak to działa

- **Praca → rejestr** (`serwer/src/heartwood/strumien.ts`). Strumień DynamoDB
  tabeli liczy stan pracy z każdej zmiany rekordu zadania (D4): `wziete` i
  `w_trakcie` → `wlasciciel`; `do_akceptacji` → `akceptujacy` (bez niego
  `writer: null`); `zrobione`, `odrzucone`, `usuniete` → `closed: true`;
  powrót do `nowe` lub `eskalowane` z otwartej pracy daje `writer: null`
  (bez zmiany `closed`), a z pracy zamkniętej (np. `odrzucone → nowe`) nie
  daje wywołania. Przekazanie zadania zmienia `writer` także bez zmiany
  stanu. Osoba bez `sub` daje `writer: null` i
  ostrzeżenie w logu. Wywołania idą do API integracji (`klient.ts`, SigV4).
  Strumień widzi tylko zmiany: zadania już w toku przy włączeniu adaptera
  (i zadania osób, którym `sub` dopisano później) dostają pracę Heartwood
  dopiero przy następnej zmianie. Właściciel może wtedy wziąć zadanie
  ponownie albo zmienić jego stan.
- **Zdarzenia → CogniFly** (`serwer/src/heartwood/zdarzenia.ts`, `zrodlo: 'pliki'`,
  D7): `lock.release_requested` → zadanie dla piszącego (bez piszącego: admini
  firmy); `change.rejected` z `reason: conflict` → zadanie „Przepisz zmiany…”
  dla `by`, inne powody → powiadomienie; `lock.broken` → powiadomienie dla
  piszącego; `quota.near` → powiadomienie, `quota.exceeded` → zadanie. Kanały:
  `['email', 'discord']`.
- **Identyfikatory** (D2, D3): `org` Heartwood = id firmy CogniFly (np. `pilot`),
  `workId` = `cognifly:<id zadania>`, osoba Heartwood = `sub` z Cognito (rekord
  `OSOBA#<osoba>` ma pole `sub`).

## Decyzje

| | |
|---|---|
| D2 | `org` = firma, `workId` = `cognifly:<id zadania>` |
| D3 | osoba = `sub` z Cognito, zapisany w rekordzie osoby |
| D4 | stan pracy ze strumienia tabeli, nie z tras API; powrót do `nowe` czyści `writer` (kontrakt, rozdz. 7) |
| D5 | wymiana i reguła zdarzeń tylko z kontekstem CDK `heartwood` |
| D6 | jedna przestrzeń `wspolne` („Wspólne”) na firmę; członkowie `write`, admini `admin` |
| D7 | mapowanie zdarzeń na zadania i powiadomienia (wyżej) |
| D8 | `token_command` = `[<binarka CogniFly>, "heartwood-token"]`; token ≥ 60 s, odświeżanie przy ≤ 5 min |
| D9 | wyszukiwanie binarki `heartwood` (niżej) |
| D10 | adresy serwera wbudowane w aplikację; konfiguracja w Application Support |
| D11 | „Pliki zadania” z prawdy serwera (`work-files`), nie z lokalnej pamięci blokad |
| D12 | licznik przy zegarze: `<zadania> ⚠<konflikty> ↑<niewysłane>` |

## Wdrożenie (D5)

Bez kontekstu `heartwood` stos CDK nie tworzy strumienia ani reguły zdarzeń
(`infra/lib/stos.ts`, `kontekstHeartwood`). Z kontekstem:

```
cdk deploy -c heartwood='{"intUrl":"https://...","intApiArn":"arn:aws:execute-api:..."}'
```

Powstają: strumień tabeli (`NEW_AND_OLD_IMAGES`), Lambda `HeartwoodPraca`,
Lambda `HeartwoodZdarzenia` i reguła EventBridge na zdarzenia `heartwood`
(`lock.release_requested`, `change.rejected`, `lock.broken`, `quota.near`,
`quota.exceeded`), kolejka `cognifly-test-heartwood-dlq` (nieudane rekordy
strumienia i zdarzenia reguły) oraz alarmy błędów obu funkcji i tej kolejki.
Serwer Heartwood nie jest częścią stosu CogniFly. Instancja testowa to osobny
stos `heartwood-test` (repo Heartwood, `infra/bin/cognifly-test.ts`), na puli
Cognito i szynie `cognifly-test` CogniFly:

| Co | Wartość |
|---|---|
| API HTTP (`intUrl`) | `https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com` |
| WebSocket | `wss://s0ulscfugh.execute-api.eu-central-1.amazonaws.com/prod` |
| `intApiArn` | `arn:aws:execute-api:eu-central-1:167702900577:eohqtq0t3j` |

Adresy HTTP i WebSocket są wbudowane w aplikację (`DEFAULT_CONFIG`).

### Przejściowo: przepięcie na Platformę

Według projektu Platformy (`~/Documents/Platforma`, rozdz. 8) to układ
przejściowy:
- rejestr firm i osób Heartwood zasila docelowo Tożsamość (zdarzenia na hubie),
  a nie skrypt `zasil-heartwood.ts`; skrypt zostaje dla przestrzeni i praw;
- Heartwood publikuje na hub, więc `RegulaHeartwood` przejdzie na hub;
- CogniFly dostaje nową pulę i klienta `cognifly` — nowe `sub`, rejestr osób
  odtwarzany ze zdarzeń Tożsamości;
- źródłem prawdy o zadaniach będzie CDC, więc stan pracy (strumień zadań)
  przejdzie do CDC albo będzie liczony z jego zdarzeń;
- aplikacja i demon sprawdzają `GET /access` przed pracą i co 5 min.

### Zasilanie rejestru (D6)

```
npx tsx infra/skrypty/zasil-heartwood.ts --firma pilot --pula <id puli Cognito> \
  --int-url <url API integracji> [--tematy Dokumenty,Oferty] [--wykonaj]
```

Domyślnie na sucho (tylko wypisuje kroki; czyta osoby firmy z DynamoDB, nie woła
Cognito ani Heartwood). Z `--wykonaj`: tworzy org, osoby (szuka `sub` w Cognito
po e-mailu i zapisuje go w rekordzie osoby), przestrzeń `wspolne`, tematy i
prawa.

## Aplikacja

Kod: `aplikacja/src-tauri/src/heartwood/`, logika UI: `aplikacja/src/logic/heartwood.ts`.

- **Nadzorca demona** (`supervisor.rs`): uruchamia `heartwood --config <plik>
  daemon` jako proces potomny, restartuje z opóźnieniem 1 s → 60 s i pokazuje
  stan w UI (`disabled`, `not_installed`, `starting`, `running`, `restarting`).
  Demon już działający na gnieździe jest przejmowany, nie dublowany. Demon działa
  tylko razem z aplikacją (zamknięcie i wylogowanie go zabijają).
- **Gniazdo** (`socket.rs`): jedna linia JSON na żądanie, odpowiedź do 1 MiB,
  dozwolone tylko `status`, `lock`, `release`, `request-release`, `history`,
  `download`, `restore`, `select`, `unselect`, `files`, `work-files`. Limit czasu
  10 s (30 s dla `files`/`work-files`, 120 s dla `download`/`select`/
  `unselect`), kod `TIMEOUT`. Wszystko idzie przez RPC do
  okna tła; okno główne nie dostaje nowych uprawnień.
- **Token** (D8): demon pyta aplikację w trybie `heartwood-token`, który czyta
  sesję z Pęku kluczy i wypisuje `accessToken` (≥ 60 s ważności, inaczej kod 1;
  kod 1 także bez odczytu zegara i przy błędzie zapisu na stdout). Sesję
  odświeża okno tła: odpytuje co ≤ 60 s i odświeża z wyprzedzeniem, gdy
  zostało ≤ 5 min (`REFRESH_MARGIN_MS` w `aplikacja/src/logic/session.ts`).
- **Binarka** (D9), kolejność: `COGNIFLY_HEARTWOOD_BIN`, plik `heartwood` obok
  pliku wykonywalnego aplikacji, `~/.cargo/bin/heartwood`. Bez niej zakładka
  pokazuje „Heartwood nie jest zainstalowany”. Pakowanie do `.app` zostaje na
  wydanie (repo Heartwood jest prywatne).
- **Konfiguracja** (D10): adresy w `DEFAULT_CONFIG.heartwoodUrl/heartwoodWsUrl`
  (`aplikacja/src/logic/config.ts`), dziś puste = wyłączone. Aplikacja pisze
  `~/Library/Application Support/pl.cognifly.aplikacja/heartwood.toml`
  (`root` = `~/Heartwood`). Zmienna `COGNIFLY_HEARTWOOD_CONFIG=<config.toml>`
  używa gotowego pliku bez zmian (testy lokalne).
- **Zakładka „Pliki”**: blokowanie ścieżek pod `root` (spoza `root` odmowa
  `OUTSIDE`/`BAD_REQUEST` po polsku), licznik (D12) i przeglądarka przestrzeni
  (niżej).

### „Pliki zadania” (D11)

Sekcja pod zadaniem w skrzynce (`windows/screens/task-files.ts`, model w
`logic/files-view.ts`, `taskFilesModel`). Dane pochodzą z serwera, nie z
pamięci aplikacji: `task.files` woła polecenie `work-files` z `workId` =
`cognifly:<id zadania>` (kontroler czyta kolejne strony, do `MAX_WORK_PAGES`)
i dokłada `sub` zalogowanej osoby. Otwarta sekcja odświeża się co 15 s (nie
dubluje trwającego żądania) oraz po każdej akcji.

- **Blokady**: lista ścieżek z autorem i czasem; blokada folderu ma dopisek
  „/ (folder)”. Przy braku odpowiedzi demona sekcja pokazuje błąd po polsku.
- **Zmienione pliki**: wersje zadania są grupowane per plik (`space` + `path`),
  najnowsza pierwsza. Wiersz pokazuje rodzaj ostatniej zmiany (zmiana,
  przywrócenie, przeniesienie z…, usunięcie), liczbę zapisów (przycisk
  rozwija listę wersji) i „Pobierz” (kopia najnowszej wersji).
- **`canEdit`**: tylko gdy `writer` pracy to `sub` zalogowanego i praca nie
  jest zamknięta. Wtedy widać „Zablokuj pliki…”, „Zwolnij” przy blokadzie i
  „Zwolnij wszystkie” (zwalnia blokady z `work-files`, po jednym `release` na
  przestrzeń). Pozostali widzą listę bez akcji.
- **`hiddenNote`**: blokady w tematach bez dostępu użytkownika nie są
  wymieniane, tylko policzone („N blokady w tematach, do których nie masz
  dostępu”).
- **Zadanie zamknięte** (`closed`): sekcja pokazuje notkę o zamkniętej pracy i
  nie oferuje akcji; lista zmian zostaje.
- „Zablokuj pliki…” dostępne dla właściciela zadania `wziete`/`w_trakcie` i
  akceptującego zadania `do_akceptacji`, gdy pliki działają na tym komputerze
  (`canLockFiles`).

### Przeglądarka przestrzeni

W zakładce „Pliki” (`windows/screens/files-tree.ts`): jeden poziom folderu
wybranej przestrzeni z polecenia `files` (`files.tree`), z okruszkami, wyborem
przestrzeni (wybrane na tym komputerze, „Inna przestrzeń…”) i filtrem
„Tylko zablokowane” (pokazuje też foldery).

- **Stany wpisu**: `free` „wolny”, `writable` „moje zadanie”, `locked`
  „zablokowany — <piszący>” (albo „nikt nie pisze”), `local_changed` „czeka na
  wysłanie”, `conflict` „konflikt”. Blokada z `workId` `cognifly:<id>` dostaje
  link „Zadanie: <opis>” (przejście do zadania, `task.focus`).
- **Akcje**: „Zablokuj do zadania…” (wolny wpis, wybór spośród zadań
  spełniających `canLockFiles`; folder blokowany jako folder; niedostępne w
  przestrzeniach prywatnych `user:`), „Poproś o zwolnienie” (cudza blokada),
  „Historia” (pliki), „Otwórz w Finderze” (foldery lokalne).
- **Finder**: `files.reveal` bierze lokalny folder przestrzeni ze świeżego
  `status` (nie z okna), sprawdza, że ścieżka leży pod `root`, i woła
  `revealItemInDir`. Tylko pokazuje element w Finderze, niczego nie uruchamia
  (`openPath` uruchomiłby zsynchronizowane `X.app`). Błędy: `NOT_LOCAL`,
  `OUTSIDE`, `OPEN_FAILED`.

### Zależność od Heartwood

„Pliki zadania” i przeglądarka wymagają klienta i serwera Heartwood z
poleceniami `work-files` i `files` (Heartwood PR #2). Starszy klient odrzuca
je jako nieznane polecenie. Instancja `heartwood-test` wymaga ponownego
wdrożenia z tym serwerem — jeszcze nie zrobione.

## Próba lokalna

Wymaga zbudowanego klienta (`cd ~/Documents/Heartwood/client && cargo build`) i
DynamoDB Local na `:8000`. Nie dotyka AWS ani repo Heartwood.

```
aplikacja/scripts/heartwood-smoke.sh        # HEARTWOOD_DIR, HEARTWOOD_SMOKE_PORT
```

Skrypt startuje serwer deweloperski Heartwood na świeżej tabeli, zasiewa
minimum (org, osoba, przestrzeń, temat, prawo), pisze tymczasowy `config.toml`
(`token_command` drukuje niepodpisany JWT) i uruchamia test `#[ignore]`
`live_status_roundtrip` (`aplikacja/src-tauri/src/heartwood/socket.rs`): start
nadzorcy tą samą ścieżką co `heartwood_start`, oczekiwanie na `running`,
`status` przez gniazdo (`ok: true`, `running: true`), `work-files` dla nieznanej
pracy `cognifly:zad_000000000000` (`ok: true`, puste blokady i wersje — brak
pracy nie jest błędem; wymaga klienta z `work-files`), zatrzymanie i brak
procesu demona. Na końcu zawsze sprząta serwer, tabelę i katalogi tymczasowe.
Ręcznie: ustaw `COGNIFLY_HEARTWOOD_CONFIG` i `COGNIFLY_HEARTWOOD_BIN`, potem
`cargo test -- --ignored live_status_roundtrip` w `aplikacja/src-tauri`.
Bez `COGNIFLY_HEARTWOOD_CONFIG` test kończy się od razu (pominięty). Skrypt
ustawia lokalne, fałszywe dane AWS (`AWS_ACCESS_KEY_ID=local`) i przy
sprzątaniu zabija serwer razem z jego procesami potomnymi.

### Sprawdzenie ręczne

- Po zamknięciu aplikacji (Cmd+Q) nie zostaje żaden proces `heartwood`
  (`pgrep -fl heartwood` nic nie zwraca).
