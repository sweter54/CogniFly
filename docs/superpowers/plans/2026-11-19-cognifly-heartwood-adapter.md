# Adapter CogniFly ↔ Heartwood — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CogniFly jako gospodarz Heartwood: aplikacja Tauri uruchamia i nadzoruje demona `heartwood`, ma natywną zakładkę „Pliki” i przyciski blokad w zadaniu, a serwer CogniFly prowadzi stan pracy, rejestr i zamienia zdarzenia Heartwood na zadania i powiadomienia.

**Architecture:** Aplikacja: cienka warstwa Rust (proces pomocniczy, gniazdo Unix, tryb `token`), logika w TS (`aplikacja/src/logic/heartwood.ts`), okno główne rozmawia z oknem tła przez istniejące RPC. Serwer: strumień DynamoDB tabeli zadań → `PUT /int/.../work/{workId}` (podpis SigV4), reguła na szynie `source=heartwood` → zadania/powiadomienia, skrypt zasilający rejestr. Infrastruktura Heartwood włączana kontekstem CDK `heartwood` — bez niego stos się nie zmienia.

**Tech Stack:** TypeScript (vitest, AWS SDK v3, `@smithy/signature-v4`), CDK, Rust (Tauri v2, `tokio` z Tauri, `serde_json`, `keyring`).

**Spec:** Heartwood `docs/superpowers/specs/2026-11-18-heartwood-design.md` rozdz. 4 i 9 oraz `docs/contract.md` rozdz. 5–9 (repo `sweter54/Heartwood`, `main` af2e311). Ten plan streszcza z nich to, co potrzebne; w razie rozbieżności rozstrzyga kontrakt.

## Decyzje (w imieniu Michała, do raportu)

- D1. Aplikacja Tauri, PR #3, #4 i gałąź odrzucenia/akceptacji są już na `main` (decyzja Michała: „najpierw cały łańcuch”). Doszło CI (`.github/workflows/ci.yml`).
- D2. `org` Heartwood = identyfikator firmy CogniFly (`pilot`); `workId` = `cognifly:<id zadania>`.
- D3. Osoba Heartwood = `sub` z Cognito. Rekord `OSOBA#<osoba>` dostaje pole `sub`. Uzupełnia je skrypt zasilania (wyszukuje użytkownika Cognito po e-mailu) i zasiew pilota.
- D4. Stan pracy jest wyliczany ze strumienia DynamoDB tabeli (każda zmiana rekordu zadania, każda ścieżka kodu), a nie w każdej trasie API. `nowe`/`eskalowane` nie dają wywołania. Mapowanie jest w kontrakcie, rozdz. 7. `do_akceptacji` bez akceptującego daje `writer: null`.
- D5. Wymiana z Heartwood i reguła zdarzeń powstają tylko z kontekstem CDK `heartwood` (`{"intUrl","intApiArn"}`). Brak wdrożenia na AWS. Konstrukcja `Heartwood` w stosie CogniFly to osobny krok przy wdrożeniu (wymaga zgody Michała i decyzji o pakowaniu prywatnego repo).
- D6. Rejestr: jedna przestrzeń `wspolne` („Wspólne”) na firmę. Wszyscy członkowie mają `write`, admini firmy mają `admin` (`isAdmin: true`). Tematy są podawane flagą skryptu (domyślnie `Dokumenty`). Skrypt domyślnie działa na sucho, jak `zasiej-pilot`.
- D7. Zdarzenia → CogniFly (`zrodlo: 'pliki'`):
  - `lock.release_requested` → zadanie dla piszącego pracy (bez piszącego: admini firmy);
  - `change.rejected` z `reason: conflict` → zadanie „Przepisz zmiany…” dla `by`; inne powody → powiadomienie dla `by`;
  - `lock.broken` → powiadomienie dla piszącego pracy;
  - `quota.near` → powiadomienie, `quota.exceeded` → zadanie; odbiorca to osoba `sub` (jeśli jest) albo admini firmy.
  - Kanały powiadomień: `['email', 'discord']` (wysyłka pomija brakujące kontakty, jak dziś).
- D8. `token_command` = `[<ścieżka binarki CogniFly>, "heartwood-token"]`. Ten tryb czyta sesję z Pęku kluczy i wypisuje `accessToken`, gdy zostało ≥ 10 s ważności, a w innym razie kończy kodem 1. Sam nie odświeża: odświeża okno tła co ≤ 60 s, a demon działa tylko razem z aplikacją.
- D9. Binarka `heartwood` (kolejność): zmienna `COGNIFLY_HEARTWOOD_BIN`, plik obok pliku wykonywalnego aplikacji (`Contents/MacOS/heartwood`), `~/.cargo/bin/heartwood`. Bez niej zakładka pokazuje „Heartwood nie jest zainstalowany”. Pakowanie do `.app` (externalBin) zostaje na wydanie, bo repo Heartwood jest prywatne i CI by go nie zbudowało.
- D10. Adresy serwera Heartwood są wbudowane w aplikację (`DEFAULT_CONFIG.heartwoodUrl/heartwoodWsUrl`), dziś `''` = wyłączone. Do testów lokalnych: `COGNIFLY_HEARTWOOD_CONFIG=<config.toml>` używa gotowego pliku bez zmian. Konfigurację pisze aplikacja do `~/Library/Application Support/pl.cognifly.aplikacja/heartwood.toml`, `root` = `~/Heartwood`.
- D11. „Zwolnij” w zadaniu zwalnia ścieżki zablokowane z tego komputera dla tego zadania (lista w `localStorage`), bo lokalne API nie ma listy blokad pracy. Zamknięcie zadania i tak zwalnia wszystko (`closed: true`).
- D12. Licznik przy zegarze: `<zadania>` + ` ⚠<konflikty>` + ` ↑<niewysłane>` (części > 0). Niewysłane = suma `spaces[].unsent`.

## Global Constraints

- Kod, identyfikatory i komentarze po angielsku. Każda funkcja ma komentarz dokumentujący (≤ 20 linii, ≤ 75 znaków w linii) w stylu repo: `Call:` / `Expects:` / `Output:`. Funkcje atomowe; duplikaty usuwać refaktorem.
- Teksty UI i komunikaty dla ludzi po polsku. Pola API CogniFly zostają po polsku (wire format).
- Bez tokenów w logach. Ścieżki plików, nazwy i powody to dane, a nie tekst sterujący. `opis` zadania budowany przez serwer ma ≤ 300 znaków, a ścieżki są w nim przycinane.
- Lokalne API: jedna linia JSON na żądanie, linia ≤ 1 MiB, odpowiedź `{"ok":true,…}` / `{"ok":false,"code","message"}`. Decyzje według `code`.
- Okno główne nie dostaje nowych uprawnień Tauri. Wszystko idzie przez RPC do okna tła. Nowe komendy Rust mają uprawnienia tylko w `capabilities/background.json`.
- Testy: `npm test` (root) i `cargo test` w `aplikacja/src-tauri` zielone; `npx tsc --noEmit` w `aplikacja` czysty.

## Review Focus

1. Zadanie przekazane innej osobie albo wysłane do akceptacji **bez zmiany stanu** (zmienia się tylko `wlasciciel`/`akceptujacy`) → ma zmienić `writer`. Test: T2, „handover changes writer without state change”.
2. Demon padający w pętli (zła konfiguracja) nie może zalać logów ani CPU. Opóźnienie rośnie 1 s → 60 s, a stan „nie działa” trafia do UI. Test: T6, `backoff_grows_and_caps`.
3. Gniazdo nie odpowiada (demon wisi) → wywołanie kończy się po 10 s kodem `TIMEOUT`, a okno nie zamarza. Test: T6, `call_times_out`.
4. Osoba bez `sub` w rejestrze → `writer: null` i ostrzeżenie w logu, bez ponawiania w nieskończoność. Test: T2, „unknown sub maps to null writer”.
5. Ścieżki z lokalnego API (spoza `root`, z `..`) w „Zablokuj pliki…” → aplikacja pozwala wybierać tylko pod `root`, a odmowę `OUTSIDE`/`BAD_REQUEST` pokazuje po polsku. Test: T7, „lock refuses paths outside root”.

---

### Task 1: Klient API integracji Heartwood (serwer)

**Files:**
- Create: `serwer/src/heartwood/klient.ts`, `serwer/src/heartwood/praca.ts`
- Modify: `serwer/package.json` (zależności `@smithy/signature-v4`, `@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node` w wersjach z `package-lock.json`)
- Test: `serwer/test/heartwood/klient.test.ts`, `serwer/test/heartwood/praca.test.ts`

**Interfaces:**
- Produces:
  - `type WorkState = { writer: string | null; closed: boolean }` (writer = osobaId CogniFly)
  - `workStateOf(t: Task): WorkState | null` — mapowanie z D4 (`wziete`, `w_trakcie` → `wlasciciel ?? null`; `do_akceptacji` → `akceptujacy ?? null`; `zrobione`, `odrzucone`, `usuniete` → `{writer: null, closed: true}`; `nowe`, `eskalowane` → `null`)
  - `workIdOf(taskId: string): string` → `cognifly:<id>`; `taskIdOf(workId: string): string | null` (tylko `cognifly:` + `TASK_ID_PATTERN`)
  - `interface IntClient { putWork(org, workId, s: {writer: string|null; closed: boolean}); putOrg(org, name); putPerson(org, sub, isAdmin); putWorkspace(org, ws, name); putTopic(org, ws, topic); putGrant(org, ws, sub, right: 'none'|'read'|'write'|'admin') }` (wszystkie `Promise<void>`)
  - `intClient(o: { url: string; region: string; fetch?: typeof fetch; sign?: Signer }): IntClient`; `type Signer = (req: {method; url; headers; body}) => Promise<Record<string,string>>` (domyślnie SigV4, usługa `execute-api`)
  - błąd: `class IntError extends Error { status: number; code: string }` (z `{code}` w ciele, inaczej `HTTP_<status>`)

- [ ] **Step 1: Write the failing tests**
  - `praca.test.ts`: tabela przypadków z D4, w tym `do_akceptacji` bez `akceptujacy` → `{writer: null, closed: false}`, `nowe` → `null`; `taskIdOf('cognifly:zad_0123456789ab')` = `'zad_0123456789ab'`, `taskIdOf('jira:1')` = `null`.
  - `klient.test.ts`: `putWork('pilot','cognifly:zad_0123456789ab',{writer:'s1',closed:false})` → `PUT <url>/int/orgs/pilot/work/cognifly%3Azad_0123456789ab`, ciało `{"writer":"s1","closed":false}`, nagłówki z `sign` przekazane do fetch. Odpowiedź 409 `{"code":"BUSY"}` → `IntError` z `code: 'BUSY'`, `status: 409`. Segmenty z `/` lub `#` są kodowane. `putGrant` z `right:'write'` → `{"right":"write"}`.
- [ ] **Step 2: Run** `npx vitest run serwer/test/heartwood` → FAIL (brak modułów).
- [ ] **Step 3: Implement** w `praca.ts` i `klient.ts`. Domyślny `sign` używa `SignatureV4` z `defaultProvider()`.
- [ ] **Step 4: Run** `npx vitest run serwer/test/heartwood` → PASS.
- [ ] **Step 5: Commit** `feat(serwer): klient API integracji Heartwood i mapowanie stanu pracy`

### Task 2: Stan pracy ze strumienia tabeli (serwer)

**Files:**
- Create: `serwer/src/heartwood/strumien.ts`
- Modify: `serwer/src/dane/konfiguracja.ts` (`zapiszOsobe` przyjmuje opcjonalne `sub`; nowe `subOsoby(firma, osoba): Promise<string | null>`)
- Test: `serwer/test/heartwood/strumien.test.ts`, `serwer/test/dane/konfiguracja.test.ts` (dopisz przypadek `sub`)

**Interfaces:**
- Consumes: `workStateOf`, `workIdOf`, `intClient` (T1).
- Produces:
  - `changedWork(oldImg: Task | undefined, newImg: Task | undefined): WorkState | null` — zwraca nowy stan, gdy różni się od starego; `null`, gdy bez zmian albo nowy jest `null`. Usunięty rekord → `null`.
  - `handleStream(event: DynamoDBStreamEvent, deps: { client: IntClient; subOf: (firma, osoba) => Promise<string|null>; log }): Promise<{ batchItemFailures: {itemIdentifier: string}[] }>` — tylko rekordy, których `pk` kończy się na `#ZAD`; firma z `pk` (`FIRMA#<f>#ZAD`); błąd wywołania → `itemIdentifier = eventID` (ponowienie). Osoba bez `sub` → `writer: null` + `log` ostrzeżenia (to nie błąd).
  - `handler` (Lambda): czyta `HEARTWOOD_INT_URL`, `AWS_REGION`; obrazy z `unmarshall`.

- [ ] **Step 1: Write the failing tests**
  - „state change sends writer”: `wziete`→`w_trakcie` z tym samym właścicielem → brak wywołania (stan pracy bez zmian); `nowe`→`wziete` (`wlasciciel:'michal'`, `subOf`→`'sub-m'`) → `putWork('pilot','cognifly:zad_…',{writer:'sub-m',closed:false})`.
  - „handover changes writer without state change”: `w_trakcie` z `wlasciciel` `michal`→`szymon` → `writer` = sub Szymona.
  - „acceptance without acceptor gives null writer”; „done closes work” (`zrobione` → `{writer:null, closed:true}`).
  - „unknown sub maps to null writer” (+ jedno ostrzeżenie w logu, brak failure).
  - „client error reports batch item failure” (IntError 503 → `batchItemFailures:[{itemIdentifier: eventID}]`).
  - „ignores non-task records” (`pk` `FIRMA#pilot#SKR#michal`).
  - `konfiguracja.test.ts`: `zapiszOsobe(f,'michal',{email,rola:'admin',sub:'s1'})` → `subOsoby(f,'michal')` = `'s1'`; bez `sub` → `null`.
- [ ] **Step 2: Run** `npx vitest run serwer/test/heartwood serwer/test/dane/konfiguracja.test.ts` → FAIL.
- [ ] **Step 3: Implement** `changedWork`, `handleStream`, `handler`, `subOsoby`.
- [ ] **Step 4: Run** te same testy → PASS (testy `konfiguracja` potrzebują DynamoDB Local na :8000).
- [ ] **Step 5: Commit** `feat(serwer): stan pracy Heartwood ze strumienia zadań`

### Task 3: Zdarzenia Heartwood → zadania i powiadomienia (serwer)

**Files:**
- Create: `serwer/src/heartwood/zdarzenia.ts`
- Modify: `serwer/src/dane/konfiguracja.ts` (`adminiFirmy`)
- Test: `serwer/test/heartwood/zdarzenia.test.ts`

**Interfaces:**
- Consumes: `taskIdOf`, `workStateOf` (T1); `pobierzZadanie`, `utworzZadanie` (`dane/kolejka.ts`); `zapiszZdarzenie` (`dane/historia.ts`); `tozsamosc` i `osobyFirmy` + rola admina z `OSOBA#` (dodaj `adminiFirmy(firma): Promise<string[]>` w `konfiguracja.ts`); `idZdarzenia('pliki', …)`.
- Produces:
  - `type HwEvent = { id: string; 'detail-type': string; source: 'heartwood'; time: string; detail: Record<string, unknown> }`
  - `plan(e: HwEvent, deps: Lookup): Promise<Reaction | null>`, gdzie `Reaction = { zdarzenie: Zdarzenie; task: boolean; recipients: string[] }`, a `Lookup = { personOf(firma, sub): Promise<string|null>; writerOf(firma, workId): Promise<string|null>; admins(firma): Promise<string[]> }`. Nieznany `detail-type` albo zły kształt → `null`.
  - `handleHeartwoodEvent(e, deps: Lookup & { save; createTask; notify })` — zapis zdarzenia (idempotentny), zadanie o id `zad_<24 hex z id zdarzenia>` dla `recipients` (gdy `task`), w innym razie `notify(firma, zdarzenie, recipients.map(o => ({osoba:o, kanaly:['email','discord']})), 'nowe')`; duplikat → bez powiadomień (jak `przetwarzanie/obsluz.ts`).
  - `handler` (Lambda, cel reguły EventBridge).
- Teksty `opis` (ścieżka przycięta do 120 znaków z `…`, osoby jako osobaId albo „ktoś spoza CogniFly”):
  - `pliki.blokada.prosba`: `Prośba o zwolnienie pliku <ws>/<path> (od: <osoba>)`
  - `pliki.zmiana.konflikt`: `Konflikt pliku <space>/<path>: przepisz swoje zmiany z kopii konfliktu`
  - `pliki.zmiana.odrzucona`: `Zmiana pliku <space>/<path> odrzucona (<powód po polsku>)`; powody: `no_lock` „brak blokady”, `name` „niedozwolona nazwa”, `excluded` „plik wykluczony”, `quota` „brak miejsca”
  - `pliki.blokada.zdjeta`: `Admin zdjął blokadę pliku <ws>/<path>`
  - `pliki.limit.blisko` / `pliki.limit.przekroczony`: `Miejsce na pliki: <used> z <limit> (80%)` / `… — limit przekroczony` (rozmiary w GB z 1 miejscem po przecinku)
- `podmiot`: `{ org, sciezka, workId? }`; `wymagaPracy` = `task`.

- [ ] **Step 1: Write the failing tests** (`plan` z fałszywym `Lookup`): każdy wiersz z D7 → oczekiwane `typ`, `task`, `recipients`, `opis`; `release_requested` dla pracy bez piszącego → admini; `workId` spoza `cognifly:` → admini; `change.rejected` `quota` → powiadomienie; zła szczegółowość (`detail.path` nie jest stringiem) → `null`; długa ścieżka przycięta, `opis.length ≤ 300`. `handleHeartwoodEvent`: duplikat (`save` → `'DUPLIKAT'`) nie woła `notify`; zadanie tworzone z `wymagaPracy`.
- [ ] **Step 2: Run** `npx vitest run serwer/test/heartwood/zdarzenia.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `writerOf` = `taskIdOf` → `pobierzZadanie` → `workStateOf(...)?.writer`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(serwer): zdarzenia Heartwood jako zadania i powiadomienia`

### Task 4: Infrastruktura i skrypt zasilania rejestru

**Files:**
- Modify: `infra/lib/stos.ts` (kontekst `heartwood`), `infra/skrypty/zasiej-pilot.ts` (`zapiszOsobe` z `sub`)
- Create: `infra/skrypty/zasil-heartwood.ts`
- Test: `infra/test/stos.test.ts` (dopisz), `infra/test/zasil-heartwood.test.ts`, `infra/test/zasiej-pilot.test.ts` (dopisz `sub`)

**Interfaces:**
- Consumes: `handler` z `heartwood/strumien.ts` i `heartwood/zdarzenia.ts`; `intClient` (T1); `zapiszOsobe` z `sub` (T2).
- Produces:
  - Kontekst `heartwood` (JSON string `{"intUrl":"https://…","intApiArn":"arn:aws:execute-api:…:<id>"}`): strumień tabeli `NEW_AND_OLD_IMAGES`; Lambda `HeartwoodPraca` (`DynamoEventSource` bez filtrów — rekordy spoza `#ZAD` pomija kod, `reportBatchItemFailures: true`, `retryAttempts: 10`, `bisectBatchOnError: true`); Lambda `HeartwoodZdarzenia` + `Rule` na szynie `{source:['heartwood'], detailType:[5 typów z D7]}`; obie z `HEARTWOOD_INT_URL`, a `HeartwoodPraca` z `execute-api:Invoke` na `<intApiArn>/*/*/int/*`. Bez kontekstu: zero nowych zasobów i brak strumienia.
  - Skrypt: `npx tsx infra/skrypty/zasil-heartwood.ts --firma pilot --pula <id> --int-url <url> [--tematy Dokumenty,Oferty] [--wykonaj]`; eksport `planZasilenia(osoby: {osoba,email,rola,sub?}[], o): Krok[]` (czysta, testowana) i `wykonaj(kroki, deps)`. Kolejność: `putOrg`, dla każdej osoby `sub` (z rekordu albo `AdminGetUser` po e-mailu → zapis do `OSOBA#`) → `putPerson(isAdmin = rola==='admin')`, `putWorkspace('wspolne','Wspólne')`, `putTopic` dla każdego tematu, `putGrant(right = admin ? 'admin' : 'write')`. Na sucho tylko wypisuje kroki.

- [ ] **Step 1: Write the failing tests**: `stos.test.ts` — „bez kontekstu heartwood brak strumienia i funkcji Heartwood” (`resourceCountIs('AWS::Lambda::EventSourceMapping', <dotychczasowa liczba>)`, `StreamSpecification` nieobecne); „z kontekstem” — `StreamViewType: NEW_AND_OLD_IMAGES`, mapowanie źródła zdarzeń dla `HeartwoodPraca`, reguła z `source: ['heartwood']`, polityka `execute-api:Invoke`. `zasil-heartwood.test.ts` — kolejność i treść kroków dla 2 osób (admin + członek), osoba bez `sub` → krok `szukajSub`, na sucho brak wywołań `IntClient`.
- [ ] **Step 2: Run** `npx vitest run infra/test` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run infra/test` → PASS; `npx cdk synth -c nadawca=x@y.pl -c emailAlarmow=x@y.pl` w `infra` bez kontekstu `heartwood` → bez różnic w zasobach względem `main` (porównaj liczbę zasobów w teście).
- [ ] **Step 5: Commit** `feat(infra): adapter Heartwood za kontekstem CDK i skrypt zasilania rejestru`

### Task 5: Tryb `heartwood-token` (Rust)

**Files:**
- Modify: `aplikacja/src-tauri/src/main.rs`, `aplikacja/src-tauri/src/vault.rs`

**Interfaces:**
- Produces:
  - `vault::fresh_access_token(raw: &str, now_ms: u64, min_left_ms: u64) -> Option<String>` — JSON sesji (`accessToken`, `expiresAt` jak `parseSession` w TS); `None`, gdy brak pól albo `expiresAt - now < min_left_ms`.
  - `vault::print_token() -> i32` — czyta wpis Pęku kluczy, wypisuje token + `\n` na stdout, zwraca 0; w innym razie nic nie wypisuje i zwraca 1.
  - `main`: gdy `std::env::args().nth(1) == Some("heartwood-token")` → `std::process::exit(vault::print_token())` **przed** `cognifly_lib::run()` (single-instance nie może się włączyć).
  - Stała `TOKEN_ARG: &str = "heartwood-token"` eksportowana z `cognifly_lib`.

- [ ] **Step 1: Write the failing tests** (`#[cfg(test)]` w `vault.rs`): ważny token z 60 s zapasu → `Some`; 5 s zapasu przy `min_left_ms = 10_000` → `None`; brak `accessToken` / zły JSON → `None`.
- [ ] **Step 2: Run** `cargo test` w `aplikacja/src-tauri` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test` → PASS.
- [ ] **Step 5: Commit** `feat(aplikacja): token_command dla Heartwood (tryb heartwood-token)`

### Task 6: Demon Heartwood — konfiguracja, nadzór, gniazdo (Rust)

**Files:**
- Create: `aplikacja/src-tauri/src/heartwood/mod.rs`, `config.rs`, `socket.rs`, `supervisor.rs`
- Modify: `aplikacja/src-tauri/src/lib.rs` (rejestracja komend, zatrzymanie demona przy `RunEvent::Exit`), `aplikacja/src-tauri/Cargo.toml` (`tokio` z funkcjami `net`, `io-util`, `time`, `process`, `sync`; `dirs`), `aplikacja/src-tauri/capabilities/background.json`, `aplikacja/src-tauri/build.rs` (manifest komend, jeśli wymagany dla uprawnień `allow-heartwood-*`)

**Interfaces:**
- Produces (komendy Tauri, tylko okno tła):
  - `heartwood_start(server_url: String, ws_url: String, org: String) -> Result<HeartwoodInfo, String>` — rozwiązuje konfigurację (D10: `COGNIFLY_HEARTWOOD_CONFIG` ma pierwszeństwo; puste URL-e bez zmiennej → `Err("DISABLED")`), binarkę (D9; brak → `Err("NOT_INSTALLED")`), zapisuje TOML i uruchamia nadzorcę. Wywołanie ponowne z tymi samymi danymi nic nie robi, z innymi restartuje demona.
  - `heartwood_stop() -> Result<(), String>` (wylogowanie)
  - `heartwood_info() -> HeartwoodInfo` gdzie `HeartwoodInfo { state: "disabled"|"not_installed"|"starting"|"running"|"restarting", root: String, restarts: u32, last_error: Option<String> }` (serde, camelCase)
  - `heartwood_call(request: serde_json::Value) -> Result<serde_json::Value, String>` — `cmd` musi być w `ALLOWED = ["status","lock","release","request-release","history","download","restore","select","unselect"]` (inaczej `Err("BAD_REQUEST")`); zwraca linię odpowiedzi demona jako JSON (także `ok:false`); błędy transportu: `Err("NOT_RUNNING")` (brak gniazda / odmowa połączenia), `Err("TIMEOUT")` (10 s; `download`/`select`/`unselect` 120 s), `Err("BAD_RESPONSE")`.
  - `config::render(c: &HwConfig) -> String` (TOML: `server_url`, `ws_url`, `token_command = [<exe>, "heartwood-token"]`, `root`, `org`); `config::socket_path(root) -> PathBuf` = `<root>/.heartwood/heartwood.sock`.
  - `socket::call(path: &Path, req: &Value, timeout: Duration) -> Result<Value, String>` (jedna linia, odczyt do `\n`, limit 1 MiB).
  - `supervisor::next_delay(restarts: u32) -> Duration` = `min(1 s · 2^restarts, 60 s)`; licznik zerowany po 5 min pracy bez awarii. Stderr demona → `log::warn!` (bez tokenów: demon ich nie wypisuje). Proces zabijany przy `heartwood_stop` i wyjściu z aplikacji (`kill_on_drop`).

- [ ] **Step 1: Write the failing tests** (`cargo test`): `render` daje poprawny TOML (parsuje się `toml`? — nie dodawaj zależności; sprawdź linie), ścieżki z cudzysłowem/`\` są escapowane; `socket_path`; `next_delay` (`backoff_grows_and_caps`: 0→1 s, 3→8 s, 10→60 s); `call` z fałszywym serwerem `tokio::net::UnixListener` w katalogu tymczasowym: odpowiedź `{"ok":true,"running":true}` wraca bez zmian; `call_times_out` (serwer nie odpowiada, timeout 200 ms → `TIMEOUT`); brak gniazda → `NOT_RUNNING`; `cmd` spoza listy → `BAD_REQUEST` bez połączenia.
- [ ] **Step 2: Run** `cargo test` → FAIL.
- [ ] **Step 3: Implement.** Stan nadzorcy w `tauri::State<Mutex<…>>`; pętla nadzoru w `tauri::async_runtime::spawn`.
- [ ] **Step 4: Run** `cargo test` i `cargo check` → PASS.
- [ ] **Step 5: Commit** `feat(aplikacja): demon Heartwood jako proces pomocniczy i lokalne API przez gniazdo`

### Task 7: Logika „Pliki” w TS i RPC (aplikacja)

**Files:**
- Create: `aplikacja/src/logic/heartwood.ts`, `aplikacja/test/heartwood.test.ts`
- Modify: `aplikacja/src/logic/config.ts` (`heartwoodUrl: ''`, `heartwoodWsUrl: ''` w `AppConfig`/`DEFAULT_CONFIG`; walidacja jak `apiUrl`, ale pusty dozwolony), `aplikacja/src/windows/protocol.ts` (metody), `aplikacja/src/logic/controller.ts` (porty, handlery, odpytywanie statusu, start/stop demona przy logowaniu/wylogowaniu i zmianie firmy), `aplikacja/src/windows/background/platform.ts` (porty `heartwood` przez `invoke`), `aplikacja/src/logic/notify.ts` (`trayTitle`), `aplikacja/test/controller.test.ts`, `aplikacja/test/notify.test.ts`, `aplikacja/test/config.test.ts`

**Interfaces:**
- Consumes: komendy z T6.
- Produces:
  - Port `HeartwoodPort { start(serverUrl, wsUrl, org): Promise<HwInfo>; stop(): Promise<void>; info(): Promise<HwInfo>; call(req: HwRequest): Promise<HwReply>; pickFiles(root: string): Promise<string[]> }`; `HwInfo` jak w T6.
  - Typy z kontraktu rozdz. 9: `HwStatus { running; connected; spaces: {space; folder; lastSeq; serverSeq: number|null; unsent: number}[]; pending: {...}[]; conflicts: {space; path; copyPath; at; message}[]; skipped: {space; path; reason; reasonText; suggestion?; hint?}[]; issues: {space; message}[] }`, `HwVersion` (`VersionRecord`).
  - Czyste funkcje: `parseStatus(v: unknown): HwStatus | null`; `fileCounts(s: HwStatus | null): { conflicts: number; unsent: number }`; `workIdFor(taskId): string` (`cognifly:<id>`); `isUnderRoot(path, root): boolean` (bezwzględna, bez segmentów `..`/`.`, prefiks `root/`); `hwMessage(code: string, message?: string): string` — polskie teksty: `NOT_RUNNING` „Heartwood nie działa — uruchamiam ponownie…”, `NOT_INSTALLED` „Heartwood nie jest zainstalowany na tym komputerze.”, `DISABLED` „Pliki nie są jeszcze włączone w tej wersji CogniFly.”, `TIMEOUT` „Heartwood nie odpowiada.”, a pozostałe kody → `message` z demona (już po polsku) albo „Nie udało się (<kod>).”; `lockedPaths(store, taskId)`, `rememberLocked(store, taskId, paths)`, `forgetLocked(store, taskId, paths)` (klucz `cognifly.heartwood.locks`, D11).
  - `TrayState` dostaje `conflicts`, `unsent`; `trayTitle` dokleja ` ⚠N` i ` ↑N` (D12); przy samych plikach (0 zadań) tytuł to np. `⚠1`.
  - `InboxView` dostaje `files: { info: HwInfo; status: HwStatus | null; counts: {conflicts; unsent} }`.
  - Metody RPC (`Methods`): `files.get` → `InboxView['files']`; `files.refresh`; `files.history {path}` → `{ versions: HwVersion[]; path }`; `files.download {path, version}` → `{ copy: string }`; `files.restore {path, version}` → `{ ok: true }`; `files.select {space, topics?}`; `files.unselect {space, topics?, yes}`; `task.lockFiles {id}` → `{ paths: string[] }` (otwiera wybór plików pod `root`, odrzuca ścieżki spoza `root`, woła `lock` z `workIdFor(id)`, zapamiętuje ścieżki); `task.releaseFiles {id}` → `{ paths: string[] }`; `task.lockedFiles {id}` → `{ paths: string[] }`; `files.pickPath` → `{ path: string | null }` (wybór pliku do historii). Odmowa demona (`ok:false`) → `RpcError(code)`, a UI pokazuje `hwMessage`.
  - Odpytywanie: `status` przy każdym `poll()` (gdy zalogowany i `info.state === 'running'`), po każdej akcji plikowej i co 15 s, gdy ekran „Pliki” jest otwarty (UI woła `files.refresh`).

- [ ] **Step 1: Write the failing tests**: `heartwood.test.ts` — `parseStatus` na przykładzie z kontraktu i na śmieciach (`null`); `fileCounts` (2 konflikty, `unsent` 3+4 → 7); `isUnderRoot` (`/Users/a/Heartwood/pilot/wspolne/x.docx` pod `/Users/a/Heartwood` → true; `/Users/a/Heartwood2/x` → false; `/Users/a/Heartwood/../x` → false); `hwMessage`; `rememberLocked`/`forgetLocked` bez duplikatów. `notify.test.ts` — `trayTitle({…waiting:3, conflicts:2, unsent:5})` = `'3 ⚠2 ↑5'`, `({waiting:0,conflicts:1,unsent:0})` = `'⚠1'`. `controller.test.ts` z fałszywym `HeartwoodPort` — po zalogowaniu `start('', '', 'pilot')` i stan `disabled` nie psuje skrzynki; „lock refuses paths outside root” (wybór zwraca ścieżkę spoza `root` → `RpcError('OUTSIDE')`, bez `call`); `task.lockFiles` woła `call({cmd:'lock', workId:'cognifly:zad_…', paths})` i zapamiętuje; `task.releaseFiles` woła `release` z zapamiętanymi i je zapomina; `ok:false code LOCKED` → `RpcError('LOCKED')`; wylogowanie woła `stop()`. `config.test.ts` — puste `heartwoodUrl` poprawne, `http://` odrzucone.
- [ ] **Step 2: Run** `npx vitest run aplikacja/test` → FAIL.
- [ ] **Step 3: Implement.** W `platform.ts` port przez `invoke('heartwood_*')` i `@tauri-apps/plugin-dialog` `open({ multiple: true, directory: false, defaultPath: root })`.
- [ ] **Step 4: Run** `npx vitest run aplikacja/test` i `npx tsc --noEmit` w `aplikacja` → PASS.
- [ ] **Step 5: Commit** `feat(aplikacja): logika plików Heartwood, RPC i licznik przy zegarze`

### Task 8: Ekran „Pliki” i przyciski w zadaniu (UI)

**Files:**
- Create: `aplikacja/src/windows/screens/files.ts`, `aplikacja/src/logic/files-view.ts`, `aplikacja/test/files-view.test.ts`
- Modify: `aplikacja/main.html` (zakładka `data-go="files"` „Pliki”, `<section id="screen-files">`), `aplikacja/src/windows/main.ts` (`SCREENS`), `aplikacja/src/windows/protocol.ts` (`Screen` + `'files'`), `aplikacja/src/windows/screens/task-actions.ts` (przyciski), `aplikacja/src/style.css`

**Interfaces:**
- Consumes: metody RPC z T7, `hwMessage`, `InboxView.files`.
- Produces: `filesViewModel(files: InboxView['files']): FilesModel` (czysta; testowana) — `banner: string | null` (stan `disabled`/`not_installed`/`restarting` → tekst `hwMessage`; `connected:false` → „Brak połączenia z serwerem plików — zmiany czekają.”); `spaces: {label, folder, synced: boolean, unsent}[]` (`synced` = `serverSeq === null || lastSeq === serverSeq`); `conflicts` (z `copyPath`); `skipped` (z `reasonText`, `suggestion`, `hint`); `issues`.
- UI (budowa DOM przez `textContent`, nigdy `innerHTML` z danymi):
  - „Przestrzenie”: wiersz na przestrzeń (folder, „Zsynchronizowane” / „Wysyłanie: N”), przyciski „Wybierz przestrzeń…” (pole `space`, opcjonalne tematy po przecinku → `files.select`) i „Odznacz” (`files.unselect`; najpierw `yes:false`; na `CONFIRM` pytanie „Usunąć folder z dysku? Pliki zostają na serwerze.” → `yes:true`; `UNSENT` → komunikat).
  - „Konflikty”: ścieżka, „Kopia: <copyPath>”, komunikat.
  - „Pominięte pliki”: ścieżka, powód, „Propozycja: <suggestion>” / wskazówka.
  - „Historia wersji”: „Wybierz plik…” (`files.pickPath`) → lista `seq`, data, autor, rodzaj; przy każdej „Pobierz kopię” (`files.download`) i „Przywróć” (`files.restore`; potwierdzenie „Przywrócić wersję <seq>? Potrzebna blokada pliku.”).
  - Zadanie (`task-actions.ts`): przy zadaniu własnym w `wziete`/`w_trakcie` albo w `do_akceptacji`, gdy `akceptujacy === view.osoba`, przyciski „Zablokuj pliki…” (`task.lockFiles`) i „Zwolnij” (`task.releaseFiles`; tylko gdy `task.lockedFiles` niepuste), a pod nimi lista zablokowanych ścieżek. Wynik akcji trafia do linii statusu.

- [ ] **Step 1: Write the failing tests** `files-view.test.ts`: `disabled` → baner D10; przestrzeń z `serverSeq` 7 i `lastSeq` 5 → `synced:false`; konflikt i pominięty plik przechodzą z polami; `connected:false` → baner offline.
- [ ] **Step 2: Run** `npx vitest run aplikacja/test/files-view.test.ts` → FAIL.
- [ ] **Step 3: Implement** `filesViewModel`, ekran i przyciski.
- [ ] **Step 4: Run** `npm test` (root), `npx tsc --noEmit` i `npm run build` w `aplikacja` → PASS.
- [ ] **Step 5: Commit** `feat(aplikacja): zakładka „Pliki” i blokady plików w zadaniu`

### Task 9: Dokumentacja i próba lokalna

**Files:**
- Create: `docs/heartwood.md` (krótko, po polsku: jak działa adapter, D2–D12, kontekst CDK `heartwood`, skrypt zasilania, `COGNIFLY_HEARTWOOD_BIN`/`COGNIFLY_HEARTWOOD_CONFIG`, próba lokalna z serwerem deweloperskim Heartwood)
- Modify: `README.md` (link)

- [ ] **Step 1:** Próba lokalna (kontroler, nie CI): zbuduj `heartwood` z `~/Documents/Heartwood/client` (`cargo build`), uruchom serwer deweloperski Heartwood (jak w `scripts/e2e-client.sh`), napisz `config.toml` z `token_command` serwera deweloperskiego. Potem uruchom w `aplikacja/src-tauri` test `#[ignore]` `live_status_roundtrip` (dopisz w `socket.rs`; czyta `COGNIFLY_HEARTWOOD_CONFIG`, startuje nadzorcę, czeka na `running`, woła `status`), wywołując `cargo test -- --ignored live_status_roundtrip` → PASS.
- [ ] **Step 2:** `npm test`, `cargo test` → PASS.
- [ ] **Step 3: Commit** `docs: adapter Heartwood (decyzje, uruchomienie, próba lokalna)`
