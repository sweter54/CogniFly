# CogniFly: dostęp i licencja — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API CogniFly odmawia pracy bez ważnej licencji `lic_cognifly`, a aplikacja i wtyczka przed pracą i co 5 min pytają Tożsamość (`GET /access?product=cognifly`) i przy `active: false` przestają pracować z czytelnym powodem.

**Architecture:** Serwer sprawdza claim `lic_cognifly` z tokenu w `kontekst()` (bez wywołań sieciowych). Klient sprawdza dostęp na żywo w Tożsamości: aplikacja w kontrolerze (przy starcie, po logowaniu, w cyklu odpytywania co 5 min i od razu po odpowiedzi API o licencji), wtyczka w CLI (wynik w pamięci podręcznej na 5 min w `~/.cognifly/dostep.json`) i w hooku startu sesji Claude. Błąd sieci nie blokuje pracy.

**Tech Stack:** TypeScript (serwer Lambda, aplikacja Tauri), Node ESM bez zależności (wtyczka), vitest.

**Spec:** `~/Documents/Platforma/docs/superpowers/specs/2026-11-19-platforma-design.md` rozdz. 7.3 (claimy `lic_<produkt>`), 7.4 (sprawdzenie dostępu), 8 („CogniFly: licencja `lic_cognifly`”). Kontrakt: `~/Documents/Platforma/contract/src/api.ts` (`AccessResult`, `AccessReason`).

## Global Constraints

- Claim `lic_cognifly`: znacznik ISO 8601 z przesunięciem = początek dnia po końcu licencji. Ważna, gdy `now < Date.parse(claim)`. Brak claimu albo nieczytelny → brak licencji.
- Nowe kody API CogniFly (403, format `{kod}` jak dziś): `BRAK_LICENCJI`, `LICENCJA_WYGASLA`.
- `GET /access?product=cognifly` z **tokenem dostępu** (nie ID) → `{active: true, sub, org, role, licenceUntil}` albo `{active: false, reason}`; `reason ∈ TOKEN_REVOKED | ACCOUNT_DISABLED | NOT_MEMBER | ORG_SUSPENDED | NO_LICENCE | LICENCE_EXPIRED`.
- Adres Tożsamości (test): `https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com` (już w `DEFAULT_CONFIG.identityUrl` aplikacji).
- Częstość: przy starcie/logowaniu/wznowieniu i nie rzadziej niż co 5 min (`ACCESS_EVERY_MS = 300_000`); wynik ważny 5 min.
- Kody, identyfikatory i komentarze po angielsku (stare pliki z polskimi nazwami zachowują swój styl); komentarz dokumentujący każdej funkcji ≤ 20 × 75 znaków; komunikaty dla ludzi po polsku.
- Teksty powodów (wspólne dla aplikacji i wtyczki), prefiks `Brak dostępu do CogniFly: `:
  `TOKEN_REVOKED` → `sesja wygasła lub została unieważniona — zaloguj się ponownie.`, `ACCOUNT_DISABLED` → `konto jest wyłączone.`, `NOT_MEMBER` → `nie należysz już do firmy.`, `ORG_SUSPENDED` → `firma jest zawieszona.`, `NO_LICENCE` → `firma nie ma licencji na CogniFly.`, `LICENCE_EXPIRED` → `licencja firmy na CogniFly wygasła.`, inny → `odmowa dostępu (<kod>).`
- Nic nie jest wdrażane ani scalane bez zgody Michała.

## Decyzje projektanta (do poprawienia przez Michała)

- **Co robi `active: false`.** `TOKEN_REVOKED`, `ACCOUNT_DISABLED`, `NOT_MEMBER` → wylogowanie i ekran logowania z powodem. `ORG_SUSPENDED`, `NO_LICENCE`, `LICENCE_EXPIRED` → sesja zostaje, ale aplikacja jest „wstrzymana”: baner z powodem, brak odpytywania zadań i akcji na zadaniach. Kolejne sprawdzenie co 5 min (albo „Odśwież”) wznawia pracę, gdy dostęp wróci. Demon Heartwood sprawdza swoją licencję sam (już działa).
- **Błąd sieci przy `/access`** nie blokuje: aplikacja pracuje dalej (API i tak egzekwuje licencję), a w logu jest wpis.
- **Wtyczka bez adresu Tożsamości** (stara konfiguracja) nie sprawdza dostępu; `konfiguruj` dostaje opcjonalne `--adres-tozsamosci`.
- **Serwer sprawdza tylko claim**, bez `POST /int/access` przy każdym żądaniu (koszt i opóźnienie); claim jest aktualny najpóźniej po 60 min, a klienci pytają `/access` co 5 min.
- **Hook startu sesji Claude** pokazuje powód odmowy zamiast podsumowania zadań, gdy dostęp jest nieaktywny.

## Review Focus

1. **Granica licencji:** claim równy „teraz” → wygasła; brak/nieczytelny → `BRAK_LICENCJI`. Test w zadaniu 1.
2. **`/access` niedostępne (sieć, 5xx):** aplikacja i wtyczka pracują dalej, bez wstrzymania. Testy w zadaniach 2 i 3.
3. **Wznowienie po przywróceniu licencji:** wstrzymana aplikacja przy kolejnym sprawdzeniu wraca do odpytywania bez ponownego logowania. Test w zadaniu 2.
4. **Wywołanie `/access` tokenem ID zamiast dostępu** daje `TOKEN_REVOKED` — klienci muszą wysyłać token dostępu. Testy sprawdzają nagłówek w zadaniach 2 i 3.
5. **Odpowiedź API 403 `LICENCJA_WYGASLA`/`BRAK_LICENCJI`** natychmiast wywołuje sprawdzenie `/access` (nie czeka 5 min). Test w zadaniu 2.

---

### Task 1: Serwer — licencja `lic_cognifly` w kontekście żądania

**Files:**
- Modify: `serwer/src/api/kontekst.ts`
- Test: `serwer/test/api/api.test.ts` (albo nowy `serwer/test/api/licencja.test.ts`)

**Interfaces:**
- Produces: `licenceState(claims: Record<string, unknown> | undefined, now: number): 'OK' | 'BRAK_LICENCJI' | 'LICENCJA_WYGASLA'` (czysta). `kontekst()` i `firmyZTokenu()` rzucają `HttpBlad(403, 'BRAK_LICENCJI' | 'LICENCJA_WYGASLA')` przed odczytem rejestru. Zmienna `COGNIFLY_LICENCE_CLAIM` (domyślnie `lic_cognifly`).

- [ ] **Step 1: Testy:** `licence_valid_before_claim`, `licence_expired_when_now_equals_claim`, `missing_or_unparsable_claim_is_no_licence` (Review Focus 1), `route_returns_403_licencja_wygasla` (zdarzenie API z claimem w przeszłości), `route_works_with_valid_licence`.
- [ ] **Step 2:** `npx vitest run serwer/test/api` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** Pełny zestaw serwera → PASS (istniejące testy dostają ważny claim w fabryce zdarzeń).
- [ ] **Step 5:** `git commit -m "feat(serwer): API refuses work without a valid lic_cognifly"`

### Task 2: Aplikacja — sprawdzanie dostępu i wstrzymanie

**Files:**
- Create: `aplikacja/src/logic/access.ts`
- Modify: `aplikacja/src/logic/controller.ts`, `aplikacja/src/windows/protocol.ts` (`InboxView.blocked: string | null`), `aplikacja/src/windows/main.ts` i/lub ekran skrzynki (baner), `aplikacja/src/logic/attention.ts` (pozycja „Brak dostępu: …” na górze kolejki), `aplikacja/src/windows/ui.ts` (komunikaty `BRAK_LICENCJI`, `LICENCJA_WYGASLA`)
- Test: `aplikacja/test/access.test.ts`, `aplikacja/test/controller.test.ts`, `aplikacja/test/attention.test.ts`

**Interfaces:**
- Produces: `type Access = { active: true } | { active: false; reason: string }`; `checkAccess(fetch, identityUrl, accessToken): Promise<Access>` (`GET {identityUrl}/access?product=cognifly`, `Authorization: Bearer <token dostępu>`; błąd sieci lub odpowiedź ≠ 200 → `NetworkError`); `accessMessage(reason): string` (teksty z Global Constraints); `LOGOUT_REASONS = ['TOKEN_REVOKED','ACCOUNT_DISABLED','NOT_MEMBER']`; `ACCESS_EVERY_MS = 300_000`.
- Kontroler: `checkAccessIfDue(force?: boolean)` wołane z `start()`/`poll()` (gdy minęło `ACCESS_EVERY_MS` albo `force`), po `confirm()` (logowanie) i po odpowiedzi API `BRAK_LICENCJI`/`LICENCJA_WYGASLA` (`force`). `LOGOUT_REASONS` → `logout()` + ekran logowania z komunikatem. Inne powody → `view.blocked = accessMessage(reason)`, odpytywanie zadań pominięte, akcje na zadaniach odrzucane kodem `BLOCKED`. Aktywny dostęp czyści `blocked` i od razu odpytuje.

- [ ] **Step 1: Testy:** `access.test.ts`: `sends_access_token_and_product`, `parses_inactive_reason`, `non_200_is_network_error`, `messages_are_polish`. `controller.test.ts`: `start_checks_access_before_poll`, `access_checked_every_five_minutes`, `licence_expired_blocks_polling_and_shows_reason`, `not_member_logs_out`, `access_network_error_does_not_block` (Review Focus 2), `active_again_unblocks_and_polls` (Review Focus 3), `api_licence_error_forces_access_check` (Review Focus 5). `attention.test.ts`: `blocked_is_first_in_queue`.
- [ ] **Step 2:** `npx vitest run aplikacja` → FAIL.
- [ ] **Step 3:** Implementacja.
- [ ] **Step 4:** `npx vitest run aplikacja` i `cd aplikacja && npx tsc --noEmit` → PASS.
- [ ] **Step 5:** `git commit -m "feat(aplikacja): access check with Identity before and during work"`

### Task 3: Wtyczka — sprawdzanie dostępu w CLI i hooku

**Files:**
- Create: `wtyczka/cli/lib/dostep.mjs`
- Modify: `wtyczka/cli/lib/api.mjs` (opcja `--adres-tozsamosci` w `konfiguruj`, pole `adresTozsamosci`; sprawdzenie przed poleceniami pracy), `wtyczka/hooks/start-sesji.mjs` (powód odmowy zamiast podsumowania), `wtyczka/skills/cognifly/SKILL.md` (opis nowego stanu `BRAK_DOSTEPU_FIRMY`), `wtyczka/mcp/dist/zadania.mjs` (przebudowa `npm run build:mcp -w wtyczka`)
- Test: `wtyczka/test/cli.test.mjs`, `wtyczka/test/hook.test.mjs`

**Interfaces:**
- Produces: `sprawdzDostep({ kat, konf, sesja, signal }) → { aktywny: true } | { aktywny: false, powod }`, wynik w `~/.cognifly/dostep.json` (`{ sub, aktywny, powod?, czas }`, ważny 5 min, plik 600); bez `konf.adresTozsamosci` → `{ aktywny: true }` bez wywołania. Błąd sieci → `{ aktywny: true }` i brak zapisu. Polecenia pracy (`skrzynka`, `zadanie`, `biore`, `stan`, `przekaz`, `odrzuc`, `usun`, `akceptuj`, `do-poprawy`, `zglos-cr`, `podsumowanie`, `zdarzenia`) przy `aktywny: false` zwracają `{ stan: 'BRAK_DOSTEPU_FIRMY', powod, komunikat }` (komunikat z Global Constraints); `TOKEN_REVOKED`/`ACCOUNT_DISABLED`/`NOT_MEMBER` dodatkowo usuwają `sesja.json`. Odpowiedź API 403 `BRAK_LICENCJI`/`LICENCJA_WYGASLA` unieważnia `dostep.json`.

- [ ] **Step 1: Testy:** `dostep_wysyla_token_dostepu_i_produkt`, `dostep_w_pamieci_przez_5_minut`, `brak_adresu_tozsamosci_nie_sprawdza`, `blad_sieci_nie_blokuje` (Review Focus 2), `licencja_wygasla_blokuje_skrzynke`, `not_member_usuwa_sesje`, `konfiguruj_zapisuje_adres_tozsamosci`, hook: `hook_pokazuje_powod_odmowy`.
- [ ] **Step 2:** `npx vitest run wtyczka` → FAIL.
- [ ] **Step 3:** Implementacja + przebudowa `dist`.
- [ ] **Step 4:** `npx vitest run wtyczka` → PASS (w tym test aktualności `dist`).
- [ ] **Step 5:** `git commit -m "feat(wtyczka): access check with Identity before work"`

### Task 4: Dokumentacja i wdrożenie

**Files:**
- Modify: `docs/przepiecie-na-platforme.md` (sekcja „Zostaje na później” → zrobione), `docs/wdrozenie-testowe.md` (`konfiguruj --adres-tozsamosci`), `README.md` jeśli opisuje stany wtyczki.

- [ ] **Step 1:** Edycja dokumentów. Instrukcja wdrożenia: `cdk deploy cognifly-test` (tylko kod Lambdy API; **ZAPYTAJ MICHAŁA**), wtyczka: `konfiguruj ... --adres-tozsamosci https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com`, aplikacja: nowe wydanie release do `/Applications`. Test na żywo (za zgodą): licencja `cognifly` firmy `pilot` na wczoraj → aplikacja wstrzymana z powodem w ≤ 5 min, wtyczka `BRAK_DOSTEPU_FIRMY`, API 403 `LICENCJA_WYGASLA` po odświeżeniu tokenu; przywrócenie `2027-12-31`.
- [ ] **Step 2:** Pełny zestaw testów → PASS.
- [ ] **Step 3:** `git commit -m "docs: access and licence checks in CogniFly"`

## Ryzyka

- **Token sprzed zmiany licencji:** claim w tokenie jest aktualny najpóźniej po 60 min; do tego czasu API przepuszcza, a odcina dopiero sprawdzenie `/access` klienta (≤ 5 min). Zgodne ze spec 7.3–7.4.
- **Tożsamość niedostępna długo:** klienci pracują dalej (decyzja: sieć nie blokuje), ochronę daje claim w API.
