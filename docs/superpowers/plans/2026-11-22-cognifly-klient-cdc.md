# CogniFly jako producent zdarzeń i interfejs zadań CDC — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CogniFly przestaje przechowywać zadania: trasy API stają się fasadą nad API zadań CDC, webhook GitHub
publikuje zdarzenia na szynę Platformy, aplikacja pokazuje numerek przy „C” ze skrzynki powiadomień CDC, a skrypt
przenosi zadania pilota do CDC — wszystko za flagą `ZADANIA_W_CDC=stare|przerwa|cdc`.

**Architecture:** Nowy moduł `serwer/src/cdc/` (klient HTTP CDC, mapowanie odpowiedzi na typy `wspolne/src/api.ts`,
flaga z SSM). `serwer/src/api/index.ts` wybiera obsługę tras według flagi: `stare` = dzisiejszy kod bez zmian,
`przerwa` = 503 dla zapisów, `cdc` = fasada. Stary kod zostaje w tym wydaniu (wycofanie flagą); usuwa go osobny plan
po tygodniu działania.

**Tech Stack:** TypeScript (Node 20, Lambda), vitest, AWS SDK v3 (EventBridge, SSM), CDK (`infra/lib/stos.ts`),
Tauri 2 (Rust `aplikacja/src-tauri`, TS `aplikacja/src`), wtyczka Node (`wtyczka/`).

**Spec:** `docs/superpowers/specs/2026-11-22-cognifly-klient-zadan-cdc-design.md` (zaakceptowany) oraz kontrakt CDC
sweter54/CDC#5 `docs/superpowers/specs/2026-11-22-cdc-zadania-kontrakt-design.md` (zaakceptowany; trasy W6, W11,
koperta zdarzeń rozdz. 3a). Wykonawca czyta oba.

## Global Constraints

- Nowy kod: identyfikatory i komentarze po angielsku, komentarz doc przy każdej funkcji (≤20 linii × 75 znaków),
  funkcje atomowe, bez kopiowania logiki (wspólne funkcje). Istniejących polskich nazw (`zadania.ts`, `Task.kandydaci`)
  nie przepisywać. Teksty dla ludzi po polsku.
- Kształt udanych odpowiedzi tras CogniFly bez zmian: typy `Task`, `InboxResponse`, `TaskResponse`,
  `TaskDetailsResponse`, `TakenResponse` z `wspolne/src/api.ts`. Pola można tylko dodawać (opcjonalne).
- Nowe kody błędów: 503 `{kod: 'PRZERWA'}`, 403 `{kod: 'BRAK_LICENCJI'}`, 504 `{kod: 'CDC_NIEDOSTEPNE'}`; konflikt
  przejścia 409 `{kod: 'KONFLIKT', komunikat}`; wyścig „biorę” 409 `{kod: 'ZAJETE', wlasciciel}` jak dziś.
- Flaga: parametr SSM `/cognifly/<etap>/zadania-w-cdc`, wartości `stare|przerwa|cdc`, brak parametru = `stare`,
  pamięć podręczna 30 s w Lambdzie.
- CDC: adres z SSM `/cdc/test/api-url` (zmienna `CDC_URL`), token osoby przekazywany bez zmian (`Authorization`),
  nagłówek firmy jak w kontrakcie (`/orgs/{org}`). Limit czasu wywołania CDC 25 s.
- Szyna Platformy: ARN z SSM `/platforma/test/hub/arn` (zmienna `PLATFORMA_SZYNA`), `Source: 'cognifly.github'`,
  `DetailType` = typ zdarzenia (`github.pr.*`), `Detail` = `{org, id, opis, ...podmiot}` bez `dane` i bez `galaz`.
- Praca Heartwood zadania: `cdc:<id zadania>`. CogniFly nie zakłada ani nie zwalnia blokad i nie woła `PUT /work`.
- Testy: `npx vitest run` w katalogu głównym (wszystkie pakiety), `cargo test` i `cargo clippy --all-targets -- -D warnings`
  w `aplikacja/src-tauri`. CI wyłączone — bramka to lokalne testy. Wdrożenia AWS tylko po „tak” Michała.
- Wersje: aplikacja `0.2.0` (package.json i tauri.conf.json), wtyczka `0.9.0`.

## Review Focus

1. Osoba bez `sub` w `KONF/OSOBA#` (np. dodana przed Tożsamością): fasada nie może jej pokazać jako pustego
   uczestnika ani wywalić całej skrzynki — pomija nieznany `sub` po stronie CDC jako `sub` w polu (tekst), a import
   zatrzymuje się z listą takich osób. Test w zad. 2 i 10.
2. CDC uśpione albo wolne (pierwsze żądanie po godzinie): trasy zwracają 504 `CDC_NIEDOSTEPNE` po 25 s, a nie 500;
   hak startu sesji milczy. Test w zad. 1 i 9.
3. Flaga przełączona w trakcie działania Lambdy (pamięć 30 s): zapis przyjęty w `stare` tuż przed `przerwa` nie może
   zniknąć — import czyta tabelę po ustawieniu `przerwa` i odczekaniu 60 s. Krok w zad. 10.
4. Webhook z tym samym `x-github-delivery` dwa razy: publikacja na szynę tylko raz (znacznik `EVT` jak dziś). Test w zad. 6.
5. Zadanie z CDC w stanie nieznanym CogniFly (`anulowane`) albo z wykonawcą `agent:`/`machine:`: skrzynka i aplikacja
   pokazują je czytelnie (`anulowane` jak `usuniete`, wykonawca jako etykieta), bez wyjątku. Test w zad. 2 i 9.

---

### Task 1: Klient HTTP CDC

**Files:**
- Create: `serwer/src/cdc/client.ts`, `serwer/test/cdc/client.test.ts`

**Interfaces:**
- Produces:
  - `interface CdcTask` — pola zadania z odpowiedzi `GET /orgs/{org}/tasks/{id}` CDC (nazwy dokładnie jak w kodzie CDC;
    wykonawca sprawdza w repo sweter54/CDC, gałąź z migracją 004: `id, state, title, description, candidates[],
    ownerSub?, ownerKind?, requester?, acceptorSub?, escalateTo[]?, createdAt, progress?, rejection?, review?,
    handedAt?, sourceKey?, externalKey?, processingBy?, events?`).
  - `interface CdcNotification { id: string; type: string; taskId?: string; title: string; createdAt: string; readAt?: string }`
  - `class CdcError extends Error { status: number; code: string; detail?: string }`
  - `interface CdcClient` z metodami (wszystkie z `token: string, org: string`):
    `mine(): Promise<CdcTask[]>` (`GET /orgs/{org}/tasks?mine=1`, wszystkie strony),
    `task(id): Promise<CdcTask>`, `transition(id, action: CdcAction, body?): Promise<CdcTask>`,
    `pass(id, to: string, note?): Promise<CdcTask>`, `create(body: CdcCreate): Promise<CdcTask>`,
    `notifications(): Promise<{ items: CdcNotification[]; unread: number }>`, `markRead(ids: string[]): Promise<number>`.
  - `type CdcAction` — nazwy przejść z kontraktu (W2): take, start, submit (do_akceptacji z `acceptor`), done, accept,
    sendBack (z `note`), reject (z `reason`), cancel; dokładne ścieżki z kodu CDC.
  - `cdcClient(baseUrl: string, fetchFn = fetch, timeoutMs = 25_000): CdcClient`

- [ ] **Step 1: Testy** (`fetchFn` podstawiony): `sends_person_token_and_org_path`, `follows_cursor_in_mine`,
  `maps_409_to_cdc_error_with_code`, `maps_403_no_access`, `times_out_after_25s_as_cdc_unavailable` (status 504,
  code `CDC_NIEDOSTEPNE`; Review Focus 2), `mark_read_returns_marked_count`.
- [ ] **Step 2:** `npx vitest run serwer/test/cdc/client.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja (`AbortController` dla limitu czasu; odpowiedź błędu CDC: `structuredContent.odmowa`
  albo JSON `{kod, komunikat}` — sprawdzić w kodzie CDC).
- [ ] **Step 4:** Test → PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): HTTP client of the CDC task API"`

### Task 2: Mapowanie zadań CDC na typy CogniFly

**Files:**
- Create: `serwer/src/cdc/map.ts`, `serwer/src/cdc/people.ts`, `serwer/test/cdc/map.test.ts`

**Interfaces:**
- Consumes: `CdcTask` (zad. 1), `Task`, `TaskState` (`wspolne/src/api.ts`), rejestr osób `KONF/OSOBA#` (`dane/konfiguracja.ts`).
- Produces:
  - `interface PeopleMap { idOf(sub: string): string; subOf(id: string): string | undefined }`
  - `peopleMap(firma: string): Promise<PeopleMap>` — z `OSOBA#` (pole `sub`); `idOf` nieznanego `sub` zwraca sam `sub`.
  - `toTask(t: CdcTask, firma: string, people: PeopleMap): Task` — stan `anulowane` → `usuniete`; `zdarzenieId` z
    `sourceKey` (ostatni segment `evt_…`) albo `''`; `wlasciciel` z `ownerSub` (dla `agent:`/`machine:` etykieta z
    `processingBy.label` albo sam identyfikator); `opis` = `title` (+ ` — description`, gdy jest); `oddano` = `handedAt`;
    `odrzucenie`/`uwagi` z `rejection`/`review`.

- [ ] **Step 1: Testy:** `maps_states_one_to_one`, `maps_cancelled_to_usuniete` (Review Focus 5),
  `takes_event_id_from_source_key`, `unknown_sub_stays_as_sub` (Review Focus 1), `machine_owner_shows_label`,
  `round_trip_of_participants_via_people_map`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): map CDC tasks to CogniFly task shape"`

### Task 3: Flaga `ZADANIA_W_CDC` i token w kontekście

**Files:**
- Create: `serwer/src/cdc/mode.ts`, `serwer/test/cdc/mode.test.ts`
- Modify: `serwer/src/api/kontekst.ts` (`Kontekst` dostaje `token: string`, surowy token osoby z `tokenOsoby`)

**Interfaces:**
- Produces: `type TaskMode = 'stare' | 'przerwa' | 'cdc'`; `taskMode(now = Date.now()): Promise<TaskMode>`
  (SSM `/cognifly/<etap>/zadania-w-cdc`, `<etap>` z `COGNIFLY_ETAP`, pamięć 30 s, brak/zła wartość → `stare`);
  `Kontekst.token`.

- [ ] **Step 1: Testy:** `missing_parameter_means_stare`, `caches_for_30_seconds`, `invalid_value_means_stare`,
  `context_carries_raw_token`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS (cały `npx vitest run serwer` — `Kontekst` jest wszędzie).
- [ ] **Step 5:** `git commit -m "feat(serwer): task mode flag and person token in context"`

### Task 4: Fasada tras zadań

**Files:**
- Create: `serwer/src/api/zadaniaCdc.ts`, `serwer/test/api/zadaniaCdc.test.ts`
- Modify: `serwer/src/api/index.ts` (wybór obsługi według `taskMode()`)

**Interfaces:**
- Consumes: `CdcClient`, `toTask`, `peopleMap`, `taskMode`, `Kontekst.token`, `osobaPoLoginie` (`GITHUB#`).
- Produces: obsługi o tych samych sygnaturach co w `zadania.ts`: `szczegoly`, `biore`, `stan`, `przekaz`, `odrzuc`, `usun`,
  `akceptuj`, `doPoprawy` (wersje CDC); `watek` zostaje z `zadania.ts` (lokalny `WATEK#`).
  Odwzorowanie: `biore`→take; `stan` `w_trakcie`→start, `do_akceptacji`→submit (`akceptujacy` → `sub`), `zrobione`→done;
  `akceptuj`→accept; `doPoprawy`→sendBack; `odrzuc`→reject; `usun`→cancel; `przekaz` `doOsoby`/`doLoginu`→pass
  (`sub` z `PeopleMap` albo `GITHUB#`); `szczegoly` → `TaskDetailsResponse` z `zdarzenie` z `HIST` po `zdarzenieId`
  (jak dziś `zdarzenieZadania`) albo `null`.
  Tryb `przerwa`: każda trasa zapisu zadań → 503 `PRZERWA`, odczyty działają na starym kodzie.
  Błędy: `CdcError` 409 przy take → `{kod:'ZAJETE', wlasciciel}` (z ponownego odczytu zadania), inne 409 →
  `{kod:'KONFLIKT', komunikat}`, 403 `NO_ACCESS` → `BRAK_LICENCJI`, 404 → 404, 504 → 504 `CDC_NIEDOSTEPNE`.

- [ ] **Step 1: Testy** (atrapa `CdcClient`): `take_maps_to_cdc_take`, `take_race_returns_zajete_with_owner`,
  `state_do_akceptacji_sends_acceptor_sub`, `pass_by_github_login_resolves_sub`, `reject_needs_reason_like_today`,
  `przerwa_mode_refuses_writes_with_503`, `stare_mode_uses_old_handlers`, `no_access_becomes_brak_licencji`,
  `details_include_event_from_history_or_null`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS (+ istniejące testy `serwer/test/api` bez zmian).
- [ ] **Step 5:** `git commit -m "feat(serwer): task routes as a facade over CDC behind the flag"`

### Task 5: Skrzynka, podsumowanie i powiadomienia

**Files:**
- Modify: `serwer/src/api/skrzynka.ts`, `serwer/src/api/index.ts` (nowa trasa `POST /powiadomienia/przeczytane`),
  `wspolne/src/api.ts`
- Test: `serwer/test/api/skrzynkaCdc.test.ts`

**Interfaces:**
- Produces:
  - `wspolne/src/api.ts`: `interface NotificationsSummary { nieprzeczytane: number; wpisy: { id: string; typ: string;
    zadanieId?: string; tytul: string; czas: string }[] }`; `InboxResponse.powiadomienia?: NotificationsSummary`
    (opcjonalne — stare klienty je ignorują).
  - Tryb `cdc`: `GET /skrzynka` = `mine()` → `toTask` + `watek` z `WATEK#` + `powiadomienia` z `notifications()`;
    `GET /podsumowanie` liczy jak dziś z tych samych danych; `POST /powiadomienia/przeczytane {ids: string[]}` →
    `markRead` → `{oznaczono: n}`.

- [ ] **Step 1: Testy:** `inbox_lists_mine_with_threads`, `inbox_carries_unread_count`, `summary_counts_like_today`,
  `mark_read_passes_ids`, `inbox_in_stare_mode_has_no_notifications_field`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): inbox and summary from CDC with the notifications inbox"`

### Task 6: Konektor GitHub na szynie Platformy

**Files:**
- Create: `serwer/src/wejscie/koperta.ts`, `serwer/test/wejscie/koperta.test.ts`
- Modify: `serwer/src/wejscie/github.ts`, `serwer/src/dane/historia.ts` (pole `opublikowano?: boolean` we wpisie `HIST`),
  `serwer/src/heartwood/zdarzenia.ts`, `serwer/src/heartwood/praca.ts`, `serwer/src/przetwarzanie/obsluz.ts`,
  `serwer/src/eskalacja/obsluz.ts` (w trybie `cdc` nic nie robią: zadania i powiadomienia robi CDC; krok 6 migracji)

**Interfaces:**
- Produces: `platformEntry(z: Zdarzenie, bus: string): PutEventsRequestEntry` — `Source 'cognifly.github'`,
  `DetailType z.typ`, `Detail JSON {org: z.firma, id: z.id, opis: z.opis, ...podmiot bez galaz}` (bez `dane`).
  Tryb `cdc`: zdarzenie idzie na `PLATFORMA_SZYNA` (zamiast `COGNIFLY_SZYNA`), sygnały dostarczeń dalej na szynę
  CogniFly; `HIST` zapisuje `opublikowano`. Tryb `przerwa`: zapis w `HIST` z `opublikowano: false`, bez publikacji.
  Tryb `stare`: jak dziś.

- [ ] **Step 1: Testy:** `envelope_has_org_id_and_flat_subject`, `envelope_drops_data_and_branch`,
  `cdc_mode_publishes_to_platform_bus`, `przerwa_mode_only_records_history`, `duplicate_delivery_published_once`
  (Review Focus 4), `failed_publish_records_false`, `cdc_mode_silences_old_notifiers_and_work_stream`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): GitHub connector publishes to the Platforma bus"`

### Task 7: Prośba o review i dostarczenia tworzą zadania w CDC

**Files:**
- Modify: `serwer/src/api/recenzje.ts`, `serwer/src/dostarczenia/obsluz.ts`, `serwer/src/cdc/client.ts`
  (metoda `createSystem(org, body)`)
- Test: `serwer/test/api/recenzjeCdc.test.ts`, `serwer/test/dostarczenia/obsluzCdc.test.ts`

**Interfaces:**
- Consumes: `CdcClient.create`, `peopleMap`.
- Produces: tryb `cdc`: `POST /recenzje` po dzisiejszym sprawdzeniu PR tworzy zadanie tokenem osoby:
  `externalKey 'github:review:<repo>#<pr>:<zglaszajacy>:<losowe>'` (jak dziś klucz zdarzenia), kandydaci = recenzenci
  (`sub`), nadawca = zgłaszający. Dostarczenie: `createSystem` — `POST /int/orgs/{org}/tasks` podpisane SigV4 (rolą
  Lambdy; ścieżkę i dopuszczenie maszyny **potwierdzić z sesją CDC przed implementacją**), `externalKey
  'github:deliver:<repo>#<pr>:<sha>'`, kandydaci = autor (po `GITHUB#`) i recenzent. Obserwacja (`DOST`) zapisuje id
  zadania CDC.

- [ ] **Step 1: Testy:** `review_request_creates_cdc_task_with_reviewers`, `review_request_repeat_returns_same_task`,
  `delivery_creates_system_task_once_per_sha`, `stare_mode_keeps_old_path`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): review requests and deliveries create CDC tasks"`

### Task 8: Pliki zadania z pracy `cdc:<id>`

**Files:**
- Modify: `serwer/src/api/pliki.ts`, `serwer/src/heartwood/klient.ts` (`putWorkRef`, `deleteWorkRef`),
  `serwer/src/api/index.ts` (trasa `POST /zadania/{id}/pliki {space, path, usun?: boolean}`)
- Test: `serwer/test/api/plikiCdc.test.ts`

**Interfaces:**
- Consumes: `CdcClient.task` (sprawdzenie, że osoba jest uczestnikiem), `IntClient.getWorkFiles`.
- Produces: tryb `cdc`: `GET /zadania/{id}/pliki` czyta pracę `cdc:<id>` (blokady z osobami — może być kilka osób,
  odwołania `refs`); `POST /zadania/{id}/pliki` dodaje/usuwa odwołanie (`PUT|DELETE /int/orgs/{org}/work/cdc:<id>/refs`).
  CogniFly nie woła `PUT /work`. Tryb `stare`: praca `cognifly:<id>` jak dziś.

- [ ] **Step 1: Testy:** `files_read_from_cdc_work_id`, `several_lockers_are_listed`, `add_ref_needs_participant`,
  `remove_ref_calls_delete`, `never_sets_writer`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): task files from the cdc work in Heartwood"`

### Task 9: Aplikacja i wtyczka

**Files:**
- Modify: `aplikacja/src/logic/api.ts`, `aplikacja/src/logic/controller.ts`, `aplikacja/src/logic/notify.ts`,
  `aplikacja/src/logic/inbox-view.ts`, `aplikacja/src-tauri/src/lib.rs` (komenda `set_badge(count: u32)` →
  `tray.set_title(Some("N"))`, `None` przy 0), `wtyczka/cli/lib/api.mjs`, `wtyczka/hooks/start-sesji.mjs`,
  `wtyczka/skills/cognifly/SKILL.md`, wersje (Global Constraints)
- Test: istniejące testy aplikacji i wtyczki + nowe w `aplikacja/src/logic/*.test.ts`

**Interfaces:**
- Consumes: `InboxResponse.powiadomienia`, `POST /powiadomienia/przeczytane`, kody `PRZERWA`, `BRAK_LICENCJI`, `CDC_NIEDOSTEPNE`.
- Produces: numerek przy „C” = `powiadomienia.nieprzeczytane` (brak pola → dzisiejsze `waitingCount`); otwarcie
  zadania oznacza jego wpisy jako przeczytane; powiadomienie systemowe z `tytul`; przycisk „Do akceptacji” tylko w
  `w_trakcie`; `usuniete` z CDC (anulowane) pokazane jako „Anulowane/usunięte”; komunikaty po polsku dla trzech
  nowych kodów; hak startu przy 504/limicie nic nie pisze; skill opisuje, że zadania są z CDC i nie tylko z GitHuba.

- [ ] **Step 1: Testy:** `badge_uses_unread_from_inbox`, `badge_falls_back_to_waiting_count`,
  `opening_task_marks_its_notifications_read`, `submit_button_only_in_progress`, `cancelled_task_renders`
  (Review Focus 5), `hook_silent_on_cdc_unavailable` (Review Focus 2), `cli_explains_przerwa`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS + `cargo test`, `cargo clippy --all-targets -- -D warnings`.
- [ ] **Step 5:** `git commit -m "feat(aplikacja,wtyczka): CDC inbox, badge on C, new error codes"`

### Task 10: Migracja pilota i odtworzenie zdarzeń

**Files:**
- Create: `infra/skrypty/przenies-do-cdc.ts`, `infra/skrypty/odtworz-zdarzenia.ts`, `infra/test/przenies-do-cdc.test.ts`

**Interfaces:**
- Consumes: `kolejka.ts` (odczyt `ZAD`), `zdarzenieZadania`, `peopleMap`, `IntClient`, `platformEntry`.
- Produces:
  - `przenies-do-cdc.ts --firma pilot [--zastosuj]` (domyślnie podgląd): sprawdza flagę `przerwa` i odczekanie 60 s od
    jej ustawienia (Review Focus 3); mapuje `ZAD` → ciało `POST /int/orgs/{org}/tasks/import` (id, stan, uczestnicy jako
    `sub`, historia, `escalate_to`, `escalate_at = utworzono + eskalacjaMin` dla `nowe`); osoba bez `sub` →
    przerwanie z listą (Review Focus 1); usuwa harmonogramy `cognifly-<etap>-esk-*`; dla każdego zadania przepisuje
    odwołania `cognifly:<id>` → `cdc:<id>` i zamyka `cognifly:<id>`; wypisuje regułę `pilot-github-pr` w formacie
    ciała reguły CDC (rozdz. 3a, osoby jako `sub`) do wgrania przez operatora CDC.
  - `odtworz-zdarzenia.ts --firma pilot --od <ISO> [--zastosuj]`: publikuje na szynę Platformy wpisy `HIST` z
    `opublikowano: false` od podanej chwili (`platformEntry`), oznacza je `true`. **Ruling:** źródłem jest `HIST`, nie
    archiwum szyny CogniFly — `HIST` ma całe zdarzenie i znacznik, archiwum odtwarza tylko na tę samą szynę.

- [ ] **Step 1: Testy:** `dry_run_writes_nothing`, `refuses_without_przerwa_flag`, `stops_on_person_without_sub`,
  `import_body_carries_escalation_deadline`, `refs_moved_and_old_work_closed`, `rule_printed_with_subs`,
  `replay_publishes_unpublished_once`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(infra): pilot migration to CDC and event replay scripts"`

### Task 11: Infrastruktura i dokumentacja

**Files:**
- Modify: `infra/lib/stos.ts` (parametr SSM flagi z wartością `stare`; zmienne `CDC_URL`, `PLATFORMA_SZYNA`,
  `COGNIFLY_ETAP` dla Lambd API, wejścia i dostarczeń; `events:PutEvents` na ARN szyny Platformy;
  `execute-api:Invoke` na `/int/*` CDC z SSM `/cdc/test/int-invoke-arn`; trasy `POST /powiadomienia/przeczytane`,
  `POST /zadania/{id}/pliki`), `infra/test/*`, `docs/przepiecie-na-cdc.md` (nowy: kroki 1–8 migracji ze specu,
  wycofanie, test dymny)
- [ ] **Step 1: Testy CDK:** `flag_parameter_defaults_to_stare`, `api_can_put_events_on_platform_bus`,
  `api_can_invoke_cdc_int`, `new_routes_exist`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementacja. **Step 4:** PASS (`npx vitest run`, `npx cdk synth` w `infra`).
- [ ] **Step 5:** `git commit -m "feat(infra): CDC facade wiring and cut-over runbook"`

## Zależności zewnętrzne (przed zad. 4–8 na żywo; testy idą na atrapach)

- API zadań CDC na teście (sesja CDC, migracja 004) — trasy i kształt `CdcTask` sprawdzić w kodzie CDC przed zad. 1.
- Potwierdzenie z sesją CDC: tworzenie zadania systemowego przez `/int` SigV4 rolą CogniFly (zad. 7).
- Reguła `pilot-github-pr` wgrana w CDC i `external_channels` dla `pilot` — operator CDC (krok 6 migracji).
