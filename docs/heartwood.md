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
| D10 | adresy serwera wbudowane w aplikację; konfiguracja w Application Support; folder plików = `<folder pracy>/Pliki` (ustala CogniFly) |
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
  (`aplikacja/src/logic/config.ts`; dziś instancja `heartwood-test`). Aplikacja
  pisze `~/Library/Application Support/pl.cognifly.aplikacja/heartwood.toml`.
- **Folder plików ustala CogniFly** (Michał, 2026-11-19): `root` =
  `<folder pracy z Ustawień>/Pliki`, np. `~/Documents/CogniFlyWorkspace/Pliki/
  wspolne/…`. Bez folderu pracy demon nie startuje; zmiana folderu pracy
  restartuje demona z nowym `root`. Gdy folder pracy jest repozytorium git,
  `/Pliki/` trafia do `.git/info/exclude`. Ścieżka gniazda
  (`<root>/.heartwood/heartwood.sock`) musi mieć ≤ 103 znaki (`ROOT_TOO_LONG`).
  Zmienna `COGNIFLY_HEARTWOOD_CONFIG=<config.toml>`
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
- „Zablokuj pliki…” widać tylko wtedy, gdy `canEdit` (piszący to użytkownik,
  praca otwarta). `canLockFiles` (właściciel zadania `wziete`/`w_trakcie` lub
  akceptujący `do_akceptacji`, pliki działają na tym komputerze) steruje tylko
  listą zadań w przeglądarce: „Zablokuj do zadania…”.

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

### Nieśledzone i „Przenieś do zadania…”

Sekcja „Nieśledzone” zakładki „Pliki” (`files.ts`, `untrackedRows` w
`files-view.ts`) pokazuje pliki leżące w folderach przestrzeni, których
Heartwood nie śledzi (pole `untracked` ze `status`). Powód („reason” i polski
`reasonText`) zgłasza demon; aplikacja wstawia go jako tekst, nie interpretuje.
Wiersze przestrzeni spoza `spaces[]` są pomijane (nie da się ich stąd przenieść).

„Przenieś do zadania…” (`files.adopt`) zawsze pyta: pokazuje listę zadań, które
użytkownik może blokować (`canLockFiles`), a ruszy dopiero po wyborze. Aplikacja
niczego nie zgaduje. Kontroler sprawdza ścieżki (pod `root`, jedna przestrzeń
`ws:`, do `MAX_ADOPT_PATHS`; przestrzeń prywatna `user:` odpada, bo nie ma w
niej zadań) i woła `adopt` z `workId` = `cognifly:<id>` oraz `taskFolder`:

- folder zadania to `Zadania/<opis> (zad_…)`; jeśli w `Zadania` jest już folder
  kończący się na `(<id>)`, używany jest ten (`existingTaskFolder`);
- nazwę buduje `taskFolderName`: opis w NFC bez `/\:*?"<>|` i znaków
  sterujących, spacje zwinięte, bez wiodących `.`, `~`, `$`, do 60 znaków; bez
  opisu zostaje samo `(<id>)`;
- zastrzeżone nazwy Windows (con, prn, aux, nul, com1–9, lpt1–9): gdy opis
  zawiera kropkę, a jego część przed pierwszą kropką to taka nazwa (np.
  `con.txt`), opis dostaje prefiks `_`; samo `aux` zostaje (`aux (zad_…)`);
- `NOT_SELECTED` (temat `Zadania` niewybrany na tym komputerze) daje
  podpowiedź „wybierz go w Przestrzeniach” (`adoptErrorText`).

### Konflikty

Sekcja „Konflikty” grupuje konflikty per plik (demon wysyła jeden wiersz na
plik): ścieżka, „N kopii”, „Pokaż kopię” i „Oznacz jako rozwiązane”. Kopie
leżą w folderze `Kopie konfliktów/` tematu pliku (dla plików z korzenia
przestrzeni: w jej korzeniu), także `.heartwood-kopie`.

- „Pokaż kopię” (`files.revealCopy`) zaznacza najnowszą kopię w Finderze;
  błędy: `OUTSIDE` (poza `root`), `NOT_COPY` (ścieżka nie jest kopią
  konfliktu, `isConflictCopy`), `OPEN_FAILED`.
- „Oznacz jako rozwiązane” (`files.resolve`) pyta: „Usunąć kopie konfliktu?
  Upewnij się, że przepisałeś zmiany.” i usuwa wszystkie kopie pliku (`space` +
  `path`); wariant z pojedynczą `copyPath` też wymaga ścieżki będącej kopią.

### Pliki zadania w API serwera

`GET /zadania/{id}/pliki` (`serwer/src/api/pliki.ts`) zwraca `{zadanie, pisze,
zamkniete, blokady[], zmiany[]}` z `work-files` Heartwood, z osobami jako id
CogniFly (po `sub`). Dostęp mają kandydat, właściciel i akceptujący zadania
(inni: 403 `BRAK_DOSTEPU`; brak zadania: 404 `NIE_ZNALEZIONO`). Wpisy z cudzych
przestrzeni prywatnych `user:` są pomijane. Bez Heartwood (brak
`HEARTWOOD_INT_URL`, czyli bez kontekstu `heartwood`) trasa daje 503
`PLIKI_WYLACZONE`.

`zasil-heartwood` zawsze dodaje temat `Zadania` (obok `--tematy`), bo tam
trafiają foldery zadań.

### Connector zadań `cognifly-zadania` (MCP)

Serwer MCP wtyczki (`wtyczka/mcp/`, deklaracja w `wtyczka/.mcp.json`, uruchamia
`node mcp/dist/zadania.mjs`). Używa sesji i konfiguracji CLI wtyczki
(`~/.cognifly`) i API CogniFly, nie gniazda demona. Cztery narzędzia, wszystkie
tylko do odczytu (`narzedzia.mjs`):

| Narzędzie | Co daje |
|---|---|
| `moje_zadania` | zadania ze skrzynki: id, opis, stan, właściciel, akceptujący, `moge_blokowac` |
| `pliki_zadania` | `GET /zadania/{id}/pliki` jednego zadania |
| `zadania_dla_pliku` | moje zadania blokujące plik, zmieniające go i te, do których mogę go dołączyć (do 30 zadań) |
| `blokada_pliku` | czy plik blokuje jedno z moich zadań; inne blokady są niewidoczne, więc poza nimi „nieznane” |

Błędy wracają po polsku (`isError`): brak logowania, brak konfiguracji, brak
dostępu, `PLIKI_WYLACZONE` itd. Wtyczka po instalacji nie ma `node_modules`,
więc serwer jest spakowany esbuildem do jednego pliku `mcp/dist/zadania.mjs`
(`mcp/zbuduj.mjs`). Po zmianach w `wtyczka/mcp/` albo `wtyczka/cli/` uruchom
`npm run build:mcp -w wtyczka` i zatwierdź plik.

### Etap 2 (następny plan)

Nie zrobione: connector Heartwood (zapisy, np. dołączanie plików do zadania
przez asystenta) i skill scalania konfliktów. Etap 1 tylko pokazuje dane i
podpowiada; decyzje i ruchy plików zostają po stronie człowieka.

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
