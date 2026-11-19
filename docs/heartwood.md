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
| D11 | „Zwolnij” zwalnia ścieżki zablokowane z tego komputera dla zadania |
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
Konstrukcja samego Heartwood w tym stosie to osobny krok
przy wdrożeniu (wymaga zgody Michała i decyzji o pakowaniu prywatnego repo).
Wdrożenia na AWS nie ma. Konstrukcja Heartwood musi dostać szynę CogniFly
(`eventBus: szyna`), bo inaczej publikuje zdarzenia na innej szynie i reguła
`RegulaHeartwood` nigdy się nie uruchomi.

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
  `download`, `restore`, `select`, `unselect`. Limit czasu 10 s (120 s dla
  `download`/`select`/`unselect`), kod `TIMEOUT`. Wszystko idzie przez RPC do
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
- **Zakładka „Pliki”** i zadanie: blokowanie ścieżek pod `root` (spoza `root`
  odmowa `OUTSIDE`/`BAD_REQUEST` po polsku), „Zwolnij” (D11), licznik (D12).

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
`status` przez gniazdo (`ok: true`, `running: true`), zatrzymanie i brak
procesu demona. Na końcu zawsze sprząta serwer, tabelę i katalogi tymczasowe.
Ręcznie: ustaw `COGNIFLY_HEARTWOOD_CONFIG` i `COGNIFLY_HEARTWOOD_BIN`, potem
`cargo test -- --ignored live_status_roundtrip` w `aplikacja/src-tauri`.
Bez `COGNIFLY_HEARTWOOD_CONFIG` test kończy się od razu (pominięty). Skrypt
ustawia lokalne, fałszywe dane AWS (`AWS_ACCESS_KEY_ID=local`) i przy
sprzątaniu zabija serwer razem z jego procesami potomnymi.

### Sprawdzenie ręczne

- Po zamknięciu aplikacji (Cmd+Q) nie zostaje żaden proces `heartwood`
  (`pgrep -fl heartwood` nic nie zwraca).
