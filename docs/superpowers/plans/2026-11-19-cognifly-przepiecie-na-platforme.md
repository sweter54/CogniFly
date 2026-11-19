# CogniFly: przepięcie na Platformę — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CogniFly test przyjmuje tokeny puli Platformy (klient `cognifly`), trzyma rejestr osób jako kopię Tożsamości (zdarzenia z huba + uzgadnianie z `/int/*`), słucha zdarzeń Heartwood na hubie `platforma-test`, a aplikacja i wtyczka logują się do nowej puli — tak, by Heartwood test i CogniFly przepiąć w jednym oknie.

**Architecture:** Stos `cognifly-test` czyta parametry `/platforma/test/...` z SSM. Autoryzator JWT API przechodzi na wydawcę Platformy. Nowy moduł `serwer/src/tozsamosc/` ma klienta `/int/*` Tożsamości (SigV4), konsumenta zdarzeń `source = tozsamosc` i uzgadnianie (po wdrożeniu przez `triggers.Trigger` i co godzinę). Oba zapisują rejestr osób CogniFly (`OSOBA#<osoba>` w firmie, `OSOBA#<sub>`/`PROFIL`) tymi samymi funkcjami. Reguła na zdarzenia Heartwood przenosi się z szyny `cognifly-test` na hub. Szyna `cognifly-test` zostaje dla webhooka GitHuba (sprawy wewnętrzne).

**Tech Stack:** TypeScript (Node 22, ESM, AWS SDK v3, `@smithy/signature-v4`), vitest + DynamoDB Local, CDK v2 (`aws-cdk-lib`, `triggers`), Tauri (aplikacja), Node ESM bez zależności (wtyczka).

**Spec:** `~/Documents/Platforma/docs/superpowers/specs/2026-11-19-platforma-design.md` (rozdz. 6, 7.1, 7.5–7.7, 8 „CogniFly”), `~/Documents/Platforma/docs/mapa-systemu.md`, kontrakt `~/Documents/Platforma/contract/src/{api,events,org}.ts`. Po stronie Heartwood: zadanie 11 planu `docs/superpowers/plans/2026-11-19-heartwood-przepiecie-na-platforme.md` (repo Heartwood).

## Ustalenia (Michał, 2026-11-19)

1. Heartwood i CogniFly przepinamy razem, w jednym oknie, bez okresu z dwiema pulami.
2. Firma `pilot` istnieje w Tożsamości (licencje `cognifly`, `heartwood`, `dashboard` do 2027-12-31), Michał jest w niej adminem z nowym `sub`. Szymona w Tożsamości nie ma.
3. `aws login` i kody e-mail wpisuje Michał. Nic nie jest wdrażane ani scalane bez jego „tak”.

## Co w CogniFly zależy dziś od starej puli `eu-central-1_ho5yKP9z4`

| Miejsce | Zależność | W tym planie |
|---|---|---|
| `infra/lib/stos.ts` | `UserPool` + `UserPoolClient`, autoryzator JWT API na tę pulę, wyjścia `PulaCognito`/`KlientCognito` | autoryzator na Platformę (zad. 3). Pula i klient **zostają w stosie bez użycia** do sprzątania po udanym oknie, żeby wycofanie było ponownym wdrożeniem poprzedniego commita |
| rejestr osób (`OSOBA#<sub>`/`PROFIL`, pole `sub` w `OSOBA#<osoba>`) | `sub` ze starej puli; bez nowego `sub` API odpowiada `403 BRAK_DOSTEPU`, a praca Heartwood dostaje `writer: null` | odtwarzany z Tożsamości (zad. 1–3) |
| `aplikacja/src/logic/config.ts` | `clientId: '67b7re8ou041svoosk3ukotqrq'` | `130crcifqe1l4uggfap3p7kiml`, sesja z innego klienta jest odrzucana (zad. 5) |
| `aplikacja/src-tauri/src/vault.rs` (`heartwood-token`) | wypisuje token zapisanej sesji | bez zmian kodu: po zad. 5 w sejfie jest tylko sesja nowej puli |
| wtyczka (`~/.cognifly/konfiguracja.json`, `sesja.json`) | `klientCognito` podawany przez `konfiguruj` | sesja z innego klienta jest odrzucana (zad. 6); w oknie `konfiguruj --klient 130cr…` |
| `infra/skrypty/zasiej-pilot.ts` | zakłada użytkowników w puli (`AdminCreateUser`), pisze tożsamość i osobę | bez Cognito, tożsamości i osób (zad. 4) |
| `infra/skrypty/zasil-heartwood.ts` | `AdminGetUser` w puli, `putOrg`, `putPerson` | bez nich; dochodzą prace otwartych zadań (zad. 4) |
| `docs/wdrozenie-testowe.md`, `docs/heartwood.md` | opis puli CogniFly | zad. 7 |

## Decyzje projektanta (do poprawienia przez Michała)

- **Dopasowanie osoby po e-mailu.** Członek Tożsamości (`sub`, `email`, `role`) trafia do rekordu `OSOBA#<osoba>` firmy, który ma ten `sub`; jeśli takiego nie ma — do rekordu z tym samym e-mailem (bez rozróżniania wielkości liter), któremu podmieniamy `sub`; jeśli i takiego nie ma — powstaje nowa osoba z identyfikatorem z części lokalnej e-maila (`jan.kowalski@x.pl` → `jan-kowalski`, przy kolizji `-2`, `-3`…). Dzięki temu `michal` zachowuje zadania, kontakt (Discord) i login GitHub.
- **Usunięcie osoby jest miękkie.** `person.removed` (albo brak osoby w Tożsamości przy uzgadnianiu) usuwa firmę z `PROFIL` jej `sub` (API od razu odpowiada 403) i oznacza `OSOBA#<osoba>` polem `usunieta` (znacznik ISO). Listy osób, adminów i rejestru dla Heartwood pomijają takie rekordy. Zadania osoby zostają (ich przekazanie to osobna sprawa, poza planem).
- **Kolejność zdarzeń.** Rekord osoby trzyma `tozsamoscAt` (czas zdarzenia EventBridge `time`). Zdarzenie starsze od zapisanego jest pomijane. Uzgadnianie zawsze zapisuje stan z `/int/*` z bieżącym czasem.
- **Uzgadnianie obejmuje wszystkie firmy z `GET /int/orgs`.** Firm nieznanych Tożsamości nie rusza. Odpowiedź różna od 200 przerywa uzgadnianie przed zapisami firmy.
- **Zdarzenia `org.*` są pomijane.** CogniFly nie ma rekordu firmy poza konfiguracją; zawieszenie i licencję obsłuży sprawdzanie dostępu (poza planem, niżej).
- **Rola:** `admin` → `admin`, `member` → `czlonek`.
- **Stara pula zostaje w stosie** (nieużywana, `RETAIN`) do osobnego sprzątania po udanym oknie.

## Poza tym planem (osobny plan „CogniFly: dostęp i licencja”)

- `GET /access?product=cognifly` w aplikacji i wtyczce przy starcie, logowaniu, wznowieniu, starcie sesji Claude i co 5 min (spec 7.4); claim `lic_cognifly` w API (spec 8).
- Zdarzenia CogniFly dla innych produktów na hub z polem `org` (dziś CogniFly takich nie publikuje).
- Usunięcie starej puli i klienta ze stosu oraz z konta, przekazywanie zadań osoby usuniętej.

## Global Constraints

- Identyfikatory i komentarze kodu po angielsku; komentarz dokumentujący każdą funkcję (wywołanie, wejście, wyjście, błędy), najwyżej 20 wierszy × 75 znaków. Funkcje atomowe, duplikaty usuwane refaktorem. Komunikaty dla ludzi i dokumentacja po polsku.
- Parametry SSM (etap `test`): `/platforma/test/hub/arn`, `/platforma/test/tozsamosc/issuer`, `/platforma/test/tozsamosc/client-id/cognifly`, `/platforma/test/tozsamosc/api-url`, `/platforma/test/tozsamosc/int-invoke-arn` (wartość już z `/*/*/int/*`).
- Wartości etapu test: wydawca `https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_aDGkHLXxk`, klient `cognifly` = `130crcifqe1l4uggfap3p7kiml`, API Tożsamości `https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com`, hub `platforma-test`.
- Zdarzenia Tożsamości: `source = tozsamosc`; obsługiwane `person.added {org, sub, email, role}`, `person.role_changed {org, sub, role}`, `person.removed {org, sub}`.
- `/int/*` Tożsamości: `GET /int/orgs?cursor`, `GET /int/orgs/{org}/people?cursor` → `{items, cursor?}`; członek `{org, sub, email, name?, role, status: active|removed}`. SigV4, `execute-api`, `eu-central-1`.
- Zdarzenia nigdy nie niosą sekretów; logi nie zawierają e-maili ani tokenów.
- **Nic nie jest wdrażane ani scalane bez wyraźnego „tak” Michała.**
- Testy: `docker compose -f docker-compose.test.yml up -d`, potem `DYNAMODB_ENDPOINT=http://localhost:8000 npm test`; aplikacja dodatkowo `cd aplikacja && npx tsc --noEmit`; Rust `cd aplikacja/src-tauri && cargo test`.

## Review Focus

1. **Spóźnione `person.added` po `person.removed`** (wcześniejszy `time`): osoba zostaje usunięta. Test w zadaniu 1.
2. **Ten sam e-mail w innej wielkości liter** (`Michal@X.pl` vs `michal@x.pl`): podmiana `sub` w istniejącym rekordzie, nie nowa osoba. Test w zadaniu 1.
3. **Tożsamość odpowiada błędem przy uzgadnianiu**: nikt nie jest usuwany. Test w zadaniu 2.
4. **Stara sesja w sejfie aplikacji po aktualizacji** (inny `clientId`): aplikacja traktuje ją jak brak sesji i czyści sejf, więc `heartwood-token` nie wypisze tokenu starej puli. Test w zadaniu 5.
5. **Osoba bez `sub` w `zasil-heartwood`** (np. Szymon spoza Tożsamości): pominięta z ostrzeżeniem, reszta zasilenia przechodzi. Test w zadaniu 4.

---

### Task 1: Rejestr osób jako kopia Tożsamości (warstwa danych)

**Files:**
- Modify: `serwer/src/dane/konfiguracja.ts`
- Test: `serwer/test/dane/konfiguracja.test.ts`

**Interfaces:**
- Produces (w `konfiguracja.ts`):
  - `type Member = { sub: string; email: string; role: 'admin' | 'member' }`.
  - `applyMember(firma: string, m: Member, at: string): Promise<'added' | 'updated' | 'skipped'>` — dopasowanie (po `sub`, potem po e-mailu bez wielkości liter, potem nowa osoba), zapis `{email, rola, sub, tozsamoscAt: at}` i usunięcie `usunieta`; `PROFIL` nowego `sub` dostaje `firmy[firma] = osoba`; przy podmianie `sub` stary `PROFIL` traci wpis tej firmy; brak `KONTAKT#<osoba>` → zapis `{email}` (istniejący kontakt nietknięty). `skipped`, gdy `at < tozsamoscAt`.
  - `removeMember(firma: string, sub: string, at: string): Promise<'removed' | 'skipped'>` — `usunieta: at`, `tozsamoscAt: at`, wpis firmy znika z `PROFIL`. `skipped` dla nieznanego `sub` albo starszego `at`.
  - `activeSubs(firma: string): Promise<string[]>` — `sub` aktywnych osób (do uzgadniania).
  - `personIdFor(email: string, taken: Set<string>): string` — czysta: część lokalna, małe litery, znaki spoza `[a-z0-9]` → `-`, bez powtórzeń i krańcowych `-`, najwyżej 40 znaków, pusta → `osoba`; przy kolizji sufiks `-2`, `-3`…
  - `osobyFirmy`, `adminiFirmy`, `rejestrOsob` pomijają rekordy z `usunieta`.

- [ ] **Step 1: Testy** w `konfiguracja.test.ts` (osobna firma na test):
  - `applyMember_new_person_gets_id_from_email`: `{sub:'s1', email:'Jan.Kowalski@x.pl', role:'member'}` → `rejestrOsob` = `[{osoba:'jan-kowalski', email:'Jan.Kowalski@x.pl', rola:'czlonek', sub:'s1'}]`, `tozsamosc('s1')` = `{[firma]: 'jan-kowalski'}`, `kontaktOsoby` = `{email:'Jan.Kowalski@x.pl'}`.
  - `applyMember_matches_existing_person_by_email_case_insensitive` (Review Focus 2): `zapiszOsobe(f,'michal',{email:'michal@x.pl', rola:'admin', sub:'stary'})`, `zapiszTozsamosc('stary', f, 'michal')`, `zapiszKontakt(f,'michal',{email:'michal@x.pl', discordWebhookRef:'ref'})`; `applyMember(f, {sub:'nowy', email:'Michal@X.pl', role:'admin'}, T1)` → `'updated'`; `subOsoby(f,'michal')` = `'nowy'`; `tozsamosc('nowy')` = `{[f]:'michal'}`; `tozsamosc('stary')` = `{}`; kontakt nadal ma `discordWebhookRef: 'ref'`.
  - `applyMember_changes_role_by_sub`: `member` → `admin` daje `adminiFirmy` z osobą.
  - `late_added_after_removed_is_skipped` (Review Focus 1): `applyMember(T1)`, `removeMember(T3)`, `applyMember(T2)` → `'skipped'`; `rejestrOsob` puste, `tozsamosc(sub)` bez firmy.
  - `removeMember_hides_person_and_revokes_profile`: po usunięciu `osobyFirmy`, `adminiFirmy`, `rejestrOsob`, `activeSubs` jej nie zawierają; ponowne `applyMember` z nowszym `at` ją przywraca.
  - `personIdFor_rules`: `'a.b+c@x'` → `'a-b-c'`, `'--@x'` → `'osoba'`, kolizja `{'jan'}` → `'jan-2'`, `{'jan','jan-2'}` → `'jan-3'`, 60 znaków → 40.
- [ ] **Step 2:** `DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run serwer/test/dane/konfiguracja.test.ts` → FAIL.
- [ ] **Step 3:** Implementacja w `konfiguracja.ts` (wyszukiwanie po `sub`/e-mailu przez istniejące `wszystkie(firma, 'OSOBA#')`).
- [ ] **Step 4:** Ten sam test → PASS; `npx vitest run --project serwer` → PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): person registry as a copy of Platforma Identity"`

### Task 2: Klient `/int/*` Tożsamości, konsument zdarzeń i uzgadnianie

**Files:**
- Create: `serwer/src/tozsamosc/klient.ts`, `serwer/src/tozsamosc/zdarzenia.ts`, `serwer/src/tozsamosc/uzgodnij.ts`
- Modify: `serwer/src/heartwood/klient.ts` (wspólny podpisany `fetch` wydzielony, jeśli trzeba, żeby nie dublować kodu SigV4)
- Test: `serwer/test/tozsamosc/klient.test.ts`, `serwer/test/tozsamosc/zdarzenia.test.ts`, `serwer/test/tozsamosc/uzgodnij.test.ts`

**Interfaces:**
- Consumes: `applyMember`, `removeMember`, `activeSubs` (zad. 1); `sigV4Signer`, `Signer` (`heartwood/klient.ts`).
- Produces:
  - `interface IdentityClient { orgs(): Promise<string[]>; people(org: string): Promise<IdentityPerson[]> }`, `type IdentityPerson = { sub: string; email: string; role: 'admin' | 'member'; status: 'active' | 'removed' }`. `identityClient({ url, region, signer?, fetch? })` przechodzi po `cursor` aż do braku; odpowiedź różna od 2xx → `IdentityError(status)`.
  - `handleIdentityEvent(e: { 'detail-type': string; time: string; detail: unknown }, deps?): Promise<void>` i `handler` (Lambda, EventBridge). `person.added`/`person.role_changed` → `applyMember(org, {sub, email?, role}, time)` (`role_changed` bez e-maila zmienia tylko rolę istniejącej osoby; nieznany `sub` → log i pominięcie), `person.removed` → `removeMember`. Inne typy i zły kształt `detail` → log i koniec (bez wyjątku, żeby nie zapełniać DLQ). Błąd DynamoDB → wyjątek (ponowienie EventBridge).
  - `reconcile(deps: { client: IdentityClient; now: () => string; log }): Promise<{ orgs: number; added: number; updated: number; removed: number }>` i `handler`. Dla każdej firmy: pobiera wszystkich członków **przed** zapisami; aktywni → `applyMember`; `sub` z `activeSubs` nieobecne wśród aktywnych → `removeMember`. Błąd jednej firmy jest logowany, pozostałe firmy idą dalej, a na końcu `handler` rzuca, jeśli któraś firma się nie udała. Log podsumowania bez e-maili.
  - Zmienna środowiskowa `TOZSAMOSC_URL`.

- [ ] **Step 1: Testy:**
  - `klient.test.ts`: `people_follows_cursor_and_signs` (dwie strony, ścieżka `/int/orgs/pilot/people?cursor=...`, nagłówki z podpisującego), `non_2xx_throws_identity_error`.
  - `zdarzenia.test.ts` (fałszywe zależności): `person_added_applies_member_with_event_time`, `role_changed_updates_role_only`, `person_removed_removes_member`, `org_events_and_bad_detail_are_ignored`.
  - `uzgodnij.test.ts` (DynamoDB Local + fałszywy klient): `reconcile_adds_new_sub_and_removes_unknown` (rekord `michal` ze starym `sub` i ten sam e-mail w Tożsamości → podmiana `sub`, `removed = 0`; osoba spoza Tożsamości z `sub` → usunięta), `reconcile_aborts_org_on_identity_error` (Review Focus 3: `people` rzuca → żadna osoba nie usunięta, `handler` kończy się błędem), `removed_status_in_identity_removes_person`.
- [ ] **Step 2:** `npx vitest run serwer/test/tozsamosc` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** `npx vitest run --project serwer` → PASS.
- [ ] **Step 5:** `git commit -m "feat(serwer): Identity event consumer and reconciliation"`

### Task 3: Stos na Platformie (autoryzator, hub, Tożsamość)

**Files:**
- Modify: `infra/lib/stos.ts`, `infra/test/stos.test.ts`

**Interfaces:**
- Consumes: `serwer/src/tozsamosc/zdarzenia.ts`, `serwer/src/tozsamosc/uzgodnij.ts` (zad. 2).
- Produces:
  - Stała `ETAP = 'test'` i funkcja `ssm(scope, nazwa)` = `StringParameter.valueForStringParameter(scope, '/platforma/test/' + nazwa)`.
  - Autoryzator `HttpJwtAuthorizer` z wydawcą `tozsamosc/issuer` i `jwtAudience: [tozsamosc/client-id/cognifly]`.
  - `hub = EventBus.fromEventBusArn(this, 'Hub', ssm('hub/arn'))`; reguła `cognifly-test-heartwood-hub` (id `RegulaHeartwoodHub`, z kontekstem `heartwood`) na `hub` zamiast `szyna`. Nowa nazwa i id, bo zmiana `EventBusName` wymusza zastąpienie, a CloudFormation nie zastępuje zasobu o własnej nazwie; stara reguła `cognifly-test-heartwood` jest usuwana.
  - Lambdy `TozsamoscZdarzenia` (`tozsamosc/zdarzenia.ts`) i `TozsamoscUzgodnij` (`tozsamosc/uzgodnij.ts`, timeout 5 min) z `COGNIFLY_TABELA`, `TOZSAMOSC_URL`; obie `grantReadWriteData` na tabeli; `TozsamoscUzgodnij` ma `execute-api:Invoke` na `ssm('tozsamosc/int-invoke-arn')`.
  - Reguła `cognifly-test-tozsamosc` na `hub`: `{source:['tozsamosc'], detailType:['person.added','person.role_changed','person.removed']}` → `TozsamoscZdarzenia` z DLQ `cognifly-test-tozsamosc-dlq` (14 dni) i `retryAttempts: 4`.
  - Reguła `cognifly-test-uzgodnij` na szynie domyślnej `rate(1 hour)` → `TozsamoscUzgodnij`; `triggers.Trigger` uruchamiający `TozsamoscUzgodnij` po każdym wdrożeniu (`executeAfter`: tabela, API HTTP z trasami i autoryzatorem, reguła `cognifly-test-tozsamosc`, reguła `cognifly-test-heartwood-hub`, gdy jest), czyli jak najpóźniej.
  - Alarmy błędów obu Lambd i DLQ (istniejące pętle alarmów).
  - Wyjścia: `Wydawca` i `KlientCognifly` (z SSM) obok dotychczasowych; `PulaCognito`/`KlientCognito` zostają (stara pula w stosie bez użycia, komentarz „do usunięcia po przepięciu”).

- [ ] **Step 1: Testy** w `stos.test.ts`:
  - `authorizer_uses_platforma_issuer_and_cognifly_client` (`AWS::ApiGatewayV2::Authorizer` z `JwtConfiguration.Issuer` i `Audience` jako `Ref` parametrów SSM `/platforma/test/tozsamosc/issuer` i `/client-id/cognifly`).
  - `heartwood_rule_is_on_the_hub` (kontekst `heartwood`: reguła `cognifly-test-heartwood-hub` ma `EventBusName` z `/platforma/test/hub/arn`).
  - `identity_rule_on_hub_targets_consumer_with_dlq`.
  - `reconcile_runs_hourly_and_after_deploy`.
  - `reconcile_may_invoke_identity_int_api_only`.
  - `github_webhook_still_publishes_to_internal_bus` (reguła `cognifly-test-przetwarzanie` na `cognifly-test`).
  - Aktualizacja liczby kolejek SQS i alarmów w istniejących testach.
- [ ] **Step 2:** `npx vitest run --project infra` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** `npx vitest run --project infra` → PASS; `cd infra && npx cdk synth -c nadawca=a@example.com -c emailAlarmow=a@example.com > /dev/null` → bez błędu (SSM jako parametry, bez logowania).
- [ ] **Step 5:** `git commit -m "feat(infra): CogniFly on the Platforma pool and hub"`

### Task 4: Skrypty zasiewu bez puli CogniFly

**Files:**
- Modify: `infra/skrypty/zasil-heartwood.ts`, `infra/skrypty/zasiej-pilot.ts`, `serwer/src/dane/kolejka.ts`, `infra/package.json` (usunięcie `@aws-sdk/client-cognito-identity-provider`, jeśli nic go nie używa)
- Test: `infra/test/zasil-heartwood.test.ts`, `infra/test/zasiej-pilot.test.ts`, `serwer/test/dane/kolejka.test.ts`

**Interfaces:**
- Consumes: `rejestrOsob` (zad. 1), `workStateOf`, `workIdOf` (`heartwood/praca.ts`), `IntClient.putWork`.
- Produces:
  - `kolejka.ts`: `otwarteZadania(firma: string): Promise<Zadanie[]>` — zadania firmy w stanach `wziete`, `w_trakcie`, `do_akceptacji` (zapytanie po partycji `FIRMA#<f>#ZAD`, ze stronicowaniem).
  - `zasil-heartwood.ts`: `Krok` bez `org`, `szukajSub`, `osoba`; nowy `{ typ: 'praca'; org; workId; writer: string | null; closed: false }` i `{ typ: 'pominieta'; osoba }`. `planZasilenia(osoby, zadania, o)` → przestrzeń, tematy (z `Zadania`), prawa (tylko osoby z `sub`; bez `sub` → krok `pominieta`), prace otwartych zadań z `writer` = `sub` osoby (osoba bez `sub` → `null`). `Zaleznosci = { client; osoby(firma); zadania(firma) }`. Opcje bez `--pula`. `wykonaj` dla `pominieta` tylko loguje „Pominięto <osoba>: brak sub z Tożsamości”.
  - `zasiej-pilot.ts`: bez `--pula`, Cognito, `zapiszTozsamosc`, `zapiszOsobe`. Zostają sekret GitHuba, kontakty (Discord), loginy GitHub, reguła. `Zaleznosci = { sm; dane }`. Opis dry-run mówi, że osoby przychodzą z Tożsamości.

- [ ] **Step 1: Testy:**
  - `zasil-heartwood.test.ts`: `plan_has_no_org_or_person_steps`, `person_without_sub_is_skipped_with_warning` (Review Focus 5: Szymon bez `sub` → `pominieta`, brak `putGrant` dla niego, reszta wykonana), `open_tasks_become_work_with_new_sub` (zadanie `w_trakcie` właściciela `michal` → `putWork('pilot','cognifly:<id>',{writer:'sub-m', closed:false})`; `do_akceptacji` → `akceptujacy`), `options_need_no_pool` (`--pula` nie jest wymagane).
  - `zasiej-pilot.test.ts`: aktualizacja — brak wywołań Cognito i `zapiszTozsamosc`/`zapiszOsobe`; kontakt i reguła jak dotąd.
  - `kolejka.test.ts`: `otwarteZadania_returns_only_open_states`.
- [ ] **Step 2:** `npx vitest run --project infra` i `--project serwer` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** Oba projekty → PASS.
- [ ] **Step 5:** `git commit -m "feat(infra): seeding scripts take people from Identity"`

### Task 5: Aplikacja na kliencie `cognifly` Platformy

**Files:**
- Modify: `aplikacja/src/logic/config.ts`, `aplikacja/src/logic/session.ts`, `aplikacja/src/logic/controller.ts`
- Test: `aplikacja/test/session.test.ts`, `aplikacja/test/config.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_CONFIG.clientId = '130crcifqe1l4uggfap3p7kiml'`; komentarz przy `heartwoodUrl`: ta sama pula Platformy.
  - `Session` dostaje `clientId: string`. `new SessionManager(vault, refresher, clientId, now?)`; `start` i odświeżenie zapisują `clientId`. `current()` traktuje sesję bez `clientId` albo z innym jako brak sesji i woła `vault.remove()` (sejf czysty → `heartwood-token` kończy kodem 1).
  - `controller.ts` podaje `this.config.clientId`.

- [ ] **Step 1: Testy:**
  - `session.test.ts`: `session_of_other_client_is_dropped_and_vault_cleared` (Review Focus 4), `session_without_client_id_is_dropped`, `start_and_refresh_store_client_id`.
  - `config.test.ts`: `default_client_is_platforma_cognifly`.
- [ ] **Step 2:** `npx vitest run --project aplikacja` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** `npx vitest run --project aplikacja` → PASS; `cd aplikacja && npx tsc --noEmit` → bez błędów; `cd aplikacja/src-tauri && cargo test` → PASS.
- [ ] **Step 5:** `git commit -m "feat(aplikacja): log in to the Platforma pool"`

### Task 6: Wtyczka odrzuca sesję innego klienta

**Files:**
- Modify: `wtyczka/cli/lib/sesja.mjs`, `wtyczka/cli/lib/api.mjs`
- Test: `wtyczka/test/cli.test.mjs`

**Interfaces:**
- Produces: `sesja.json` ma pole `klient` (= `konf.klientCognito` przy logowaniu i odświeżeniu). Odczyt sesji z innym albo brakującym `klient` usuwa `sesja.json` i kończy się stanem `WYMAGA_LOGOWANIA`.

- [ ] **Step 1: Test** `sesja_innego_klienta_wymaga_logowania` (sesja z `klient: 'stary'`, konfiguracja z `klientCognito: 'nowy'` → `WYMAGA_LOGOWANIA`, plik usunięty) i `kod_zapisuje_klienta_w_sesji`.
- [ ] **Step 2:** `npx vitest run --project wtyczka` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** `npx vitest run --project wtyczka` → PASS.
- [ ] **Step 5:** `git commit -m "feat(wtyczka): drop sessions of another Cognito client"`

### Task 7: Dokumentacja i instrukcja wspólnego okna

**Files:**
- Create: `docs/przepiecie-na-platforme.md` (instrukcja okna, kroki niżej, z wycofaniem)
- Modify: `docs/wdrozenie-testowe.md` (logowanie przez Platformę, zasiew bez puli, konfiguracja wtyczki z `KlientCognifly`), `docs/heartwood.md` (rejestr z Tożsamości, reguła na hubie, `zasil-heartwood` bez `--pula`, usunięcie „Przejściowo”), `README.md` (jeśli opisuje pulę)

- [ ] **Step 1:** Edycja dokumentów. Instrukcja okna (kroki 5 i 6 zadania 11 Heartwood, jedno po drugim):
  1. Przed oknem: PR scalony do `main` (za zgodą), `npm ci && npm test` zielone; Michał: `aws login`.
  2. `cd infra && npx cdk diff cognifly-test -c nadawca=… -c emailAlarmow=… -c heartwood='{"intUrl":"https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com","intApiArn":"arn:aws:execute-api:eu-central-1:167702900577:eohqtq0t3j"}'` — oczekiwane: nowe Lambdy `TozsamoscZdarzenia`, `TozsamoscUzgodnij`, reguły, DLQ, trigger; autoryzator z nowym wydawcą; nowa reguła `cognifly-test-heartwood-hub` na hubie, stara `cognifly-test-heartwood` usunięta; **brak zastąpienia** tabeli, puli, API HTTP. **ZAPYTAJ MICHAŁA.**
  3. **Krok 5 (Heartwood):** wdrożenie `heartwood-test` według zadania 11 Heartwood i sprawdzenie jego uzgadniania.
  4. **Krok 6 (CogniFly), od razu po kroku 5:** `npx cdk deploy cognifly-test` z tymi samymi `-c`. Sprawdzenie: log `cognifly-test-tozsamoscuzgodnij` (`orgs ≥ 1, updated ≥ 1`), DLQ `cognifly-test-tozsamosc-dlq` pusta, `aws dynamodb get-item` na `OSOBA#michal` ma nowy `sub`.
  5. `npx tsx infra/skrypty/zasil-heartwood.ts --firma pilot --int-url https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com` (dry-run) → **ZAPYTAJ MICHAŁA** → z `--wykonaj`.
  6. Aplikacja: nowa wersja z `main` (`cd aplikacja && npx tauri build`), uruchomienie, logowanie kodem e-mail (Michał). `heartwood-token` wypisuje token (sprawdzenie tylko długości), `heartwood status` bez błędów autoryzacji.
  7. Wtyczka: `node wtyczka/cli/cognifly.mjs konfiguruj --adres-api https://td5k44easl.execute-api.eu-central-1.amazonaws.com --klient 130crcifqe1l4uggfap3p7kiml --region eu-central-1 --firma pilot`, potem logowanie (Michał wpisuje kod); `/ja` zwraca `michal`.
  8. Dalej kroki 7–11 zadania 11 Heartwood.
  Wycofanie: `git checkout <poprzedni main>` i `cdk deploy` (stara pula nadal w stosie), poprzednia wersja aplikacji, `konfiguruj --klient 67b7re8ou041svoosk3ukotqrq`; Heartwood według swojego planu.
- [ ] **Step 2:** `npm test` (całość) → PASS.
- [ ] **Step 3:** `git commit -m "docs: CogniFly on Platforma and the joint cutover window"`

## Ryzyka

- **Okno rozjechane między krokiem 5 a 6:** aplikacja ze starą sesją dostaje 401 z Heartwood, a zdarzenia Heartwood trafiają na hub, gdzie CogniFly jeszcze nie słucha (archiwum huba 30 dni pozwala je odtworzyć). Łagodzenie: kroki jedno po drugim.
- **Trigger uzgadniania nie powiedzie się** (np. brak uprawnień do `/int/*`): wdrożenie CogniFly się wycofa. Wtedy log Lambdy i poprawka przed ponowną próbą; Heartwood działa dalej na Platformie, ale aplikacja nie przejdzie autoryzacji API CogniFly (403) do czasu poprawki.
- **Prace otwarte bez piszącego** między uzgadnianiem Heartwood (stary `sub` → `writer = null`) a `zasil-heartwood --wykonaj`: blokady nie są dostępne przez kilka minut.
