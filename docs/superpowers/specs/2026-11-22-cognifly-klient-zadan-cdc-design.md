# CogniFly jako producent zdarzeń i interfejs zadań CDC (projekt)

Data: 2026-11-22. Status: projekt do akceptacji Michała. Opiera się na zaakceptowanym kontrakcie zadań CDC
(sweter54/CDC, PR #5, `docs/superpowers/specs/2026-11-22-cdc-zadania-kontrakt-design.md`, dalej „kontrakt”).
Implementacja po akceptacji tego projektu i po wdrożeniu API zadań CDC na test.

Decyzje Michała (2026-11-22):
- właścicielem zadań, ich cyklu życia, reguł i powiadomień jest CDC; szyna Platformy jest jedynym łącznikiem;
- CogniFly ani Heartwood nie mają logiki „zdarzenie → zadanie / powiadomienie”; CogniFly jest producentem zdarzeń
  i interfejsem (aplikacja, CLI, skille, hak startu sesji, MCP);
- CogniFly nie ogranicza się do repozytoriów git: skrzynka pokazuje każde zadanie z CDC, które czeka na osobę;
- Heartwood nie zna zadań CDC: zna tylko identyfikator pracy `cdc:<id>` i zapisuje, które pliki zmieniono w ramach
  pracy; „pliki zadania” składa interfejs przy odczycie.

## 0. Inwentaryzacja: co CogniFly dziś trzyma i robi sam

Jedna tabela DynamoDB `cognifly-test-dane`. Los: **CDC** (przechodzi), **zostaje** (w CogniFly), **znika**.

| Pozycja | Dziś (klucz / kod) | Los |
|---|---|---|
| Zadanie, wpis skrzynki kandydata | `FIRMA#f#ZAD`, `FIRMA#f#SKR#osoba`, `dane/kolejka.ts` | **CDC** (import); w CogniFly **znika** |
| Stany, „biorę”, przekaż, odrzuć, usuń, akceptacja, do poprawy | `kolejka.ts`, `api/zadania.ts` | **CDC** (kontrakt W1–W3); trasy CogniFly zostają jako fasada |
| Eskalacja (Scheduler, Lambda `Eskalacja`) | `przetwarzanie/obsluz.ts`, `eskalacja/` | **CDC** (budzik W4); w CogniFly **znika** |
| Silnik reguł, `REGULA#`, `ROLA#` | `reguly/silnik.ts`, `dane/konfiguracja.ts` | **CDC** (rozdz. 3a, 1:1); w CogniFly **znika** (grupy `ROLA#` nieużywane) |
| Powiadomienia e-mail, Discord, `KONTAKT#` | `powiadomienia/*` | **CDC** (adaptery portuje CDC); w CogniFly **znika** po przepięciu firmy |
| Webhook GitHub (HMAC, mapowanie, dedup `EVT`) | `wejscie/github.ts`, `mapuj-github.ts`, `historia.ts` | **zostaje** jako konektor GitHub: publikuje zdarzenia na szynę Platformy |
| Historia zdarzeń wejścia (`HIST`, 90 dni, `GET /zdarzenia`) | `historia.ts` | **zostaje** (dziennik konektora) |
| Prośba o code review (`POST /recenzje`) | `api/recenzje.ts` | sprawdzenie PR **zostaje**; zadanie tworzy CDC (`POST /orgs/{org}/tasks` tokenem osoby, `externalKey`) |
| Łańcuchy dostarczeń (obserwacja PR, ocena GraphQL, zamiatanie) | `dostarczenia/*`, `DOST`, `REJESTR#DOSTARCZENIA` | **zostaje** w konektorze GitHub; „Dostarcz PR” tworzy CDC (`POST` jako maszyna, `externalKey`) |
| Stan pracy Heartwood (strumień → `PUT /int/.../work`, piszący według stanu) | `heartwood/praca.ts`, `strumien.ts` | **znika** (rozdz. 5, pkt 4) |
| Zadania z Heartwood (`lock.release_requested` itd.) | `heartwood/zdarzenia.ts` | **CDC** (reguły na `source=heartwood`); w CogniFly **znika** |
| Pliki zadania (`GET /zadania/{id}/pliki`, MCP `pliki_zadania` itd.) | `api/pliki.ts`, `wtyczka/mcp` | **zostaje**: zadanie z CDC + pliki pracy `cdc:<id>` z Heartwood |
| Wątek Claude przy zadaniu, login GitHub → osoba | `WATEK#`, `KONF/GITHUB#` | **zostaje** |
| Rejestr osób, profil, licencja | `KONF/OSOBA#`, `PROFIL` | **zostaje** (kopia z Tożsamości; poza zakresem) |

## 1. Cele

1. Jedno źródło prawdy o zadaniach i powiadomieniach: CDC. CogniFly nie ma rekordu zadania ani reguły.
2. Zdarzenia z GitHuba trafiają na szynę jako zdarzenia; zadania i powiadomienia z nich robi CDC.
3. Osoba w aplikacji, CLI, skillach i przy starcie sesji Claude widzi wszystkie zadania i powiadomienia z CDC, które na
   nią czekają (nie tylko z GitHuba), z licznikiem przy ikonie „C”, i działa na nich jak dziś: biorę, stany, przekaż,
   odrzuć, akceptacja, „Pracuj w Claude”, pliki zadania. Status po pracy idzie do CDC.
4. Zadania pilota (otwarte i historia) są w CDC z tymi samymi id.

Po czym poznamy (test dymny na `pilot`): webhook GitHub → zadanie w `zadania_lista` (MCP CDC) i w aplikacji, licznik
przy „C” rośnie; zadanie utworzone w Claude przez MCP CDC też pojawia się w aplikacji; „biorę” i „zrobione” w aplikacji
zmieniają stan w CDC; tabela CogniFly nie ma rekordów `ZAD`/`SKR` pisanych po przejściu.

## 2. Wymagania

- R1. Zadania i powiadomienia CogniFly czyta i zmienia wyłącznie przez API CDC: tokenem osoby (klient `cognifly`,
  kontrakt W9), a zadania systemowe (dostarczenie) jako maszyna.
- R2. Publiczne API CogniFly (`/skrzynka`, `/podsumowanie`, `/zadania/{id}…`, `/recenzje`, `/dostarczenia`) zostaje
  z tym samym kształtem udanych odpowiedzi (typy z `wspolne/src/api.ts`), żeby stare wersje klientów działały.
  Dochodzą kody 503 `PRZERWA` i 403 `BRAK_LICENCJI` (z `NO_ACCESS` CDC).
- R3. Konektor GitHub publikuje zmapowane zdarzenia na szynę Platformy w kopercie z kontraktu (rozdz. 3a: `source`,
  `detail-type`, `detail.org`, `detail.id = evt_…`, pola `podmiot` w `detail`, `detail.opis`).
- R4. Licznik przy „C” i hak startu sesji pokazują nieprzeczytane wpisy skrzynki powiadomień CDC i zadania czekające
  na osobę.
- R5. Migracja pilota jednorazowa, z krótkim oknem bez zapisów, bez utraty zadań; przepięcie powiadomień według
  procedury kontraktu (rozdz. 3a, „Przełącznik przepięcia”).

## 3. Najprostsze rozwiązanie

- **Fasada.** Serwer CogniFly zostaje pod tymi samymi trasami i przekazuje je do CDC tokenem osoby, tłumacząc odpowiedź
  na dzisiejszy kształt `Task`:

  | Trasa CogniFly | CDC |
  |---|---|
  | `GET /skrzynka`, `GET /podsumowanie` | `GET /orgs/{org}/tasks?mine=1` + skrzynka powiadomień |
  | `GET /zadania/{id}` | `GET /orgs/{org}/tasks/{id}` (z historią) |
  | `POST …/biore`, `…/stan`, `…/akceptuj`, `…/do-poprawy`, `…/odrzuc`, `…/usun` | przejścia stanu z kontraktu (W1–W2) |
  | `POST …/przekaz` | `POST …/tasks/{id}/pass` (login GitHub → `sub` po `GITHUB#`) |
  | `POST /recenzje` | sprawdzenie PR, potem `POST /orgs/{org}/tasks` z `externalKey` |

- **Konektor GitHub.** Webhook zostaje w kodzie CogniFly (HMAC, mapowanie, `EVT`, `HIST`). Zamiast szyny `cognifly-test`
  i Lambdy `Przetwarzanie` publikuje zdarzenie na szynę Platformy z `source=cognifly.github`. Zadanie i powiadomienia
  robi z tego reguła CDC. Dostarczenia zostają w konektorze: gdy PR jest gotowy, konektor tworzy „Dostarcz PR”
  wywołaniem `POST /orgs/{org}/tasks` jako maszyna (kandydaci: autor i recenzent, `externalKey` z repo, PR i sha) —
  reguła tego nie zrobi, bo kandydaci zależą od PR.
- **Aplikacja.** Ikona w pasku menu pokazuje liczbę: nieprzeczytane powiadomienia i zadania `nowe`/`eskalowane`
  czekające na osobę. Odświeżanie co 60 s, jak dziś. Powiadomienie systemowe przy nowym wpisie, jak dziś.
- **Hak startu sesji i skill** czytają to samo przez fasadę (`/podsumowanie`). Polecenia wtyczki bez zmian.
- **Pliki zadania**: `GET /zadania/{id}/pliki` = zadanie z CDC + `GET /int/orgs/{org}/work/cdc:<id>/files` z Heartwood.
  Skill i aplikacja przy pracy nad zadaniem blokują i wysyłają z `--work cdc:<id>`.
- **Usunięte z CogniFly:** `kolejka.ts`, `reguly/`, `eskalacja/`, `przetwarzanie/`, `powiadomienia/`, `heartwood/praca.ts`,
  `heartwood/strumien.ts`, `heartwood/zdarzenia.ts`, szyna `cognifly-test` (po okresie archiwum), strumień DynamoDB.
- **Migracja pilota** (jedna kolejność w całym dokumencie):
  1. Wdrożenie CogniFly z flagą `ZADANIA_W_CDC=stare|przerwa|cdc` (SSM); stary i nowy kod w jednym wydaniu.
  2. Flaga `przerwa`: trasy zapisu zadań → 503 `PRZERWA`; webhook przyjmuje i zapisuje w `HIST`, ale nie tworzy zadań;
     zdarzenia zostają w archiwum szyny `cognifly-test`.
  3. Usunięcie harmonogramów `cognifly-test-eskalacje`.
  4. Import: `POST /int/orgs/{org}/tasks/import` (id, stan, uczestnicy jako `sub`, historia, `escalate_to`, termin
     eskalacji). Reguła `pilot-github-pr` → reguła CDC (osoby jako `sub`). Skrypt zamyka prace `cognifly:<id>` w Heartwood.
  5. Flaga `cdc`: fasada i konektor na szynie Platformy.
  6. Przepięcie powiadomień (kontrakt): operator włącza `external_channels` dla `pilot` w CDC, potem CogniFly przestaje
     wysyłać dla `pilot` (ta sama flaga `cdc`). Ryzyko: chwilowy dubel, nie luka.
  7. Skrypt odtwarza z archiwum szyny `cognifly-test` zdarzenia z okna `przerwa` na szynę Platformy.
  8. Test dymny (rozdz. 1). Po tygodniu bez problemów: usunięcie starego kodu i zasobów.
- **Wycofanie:** do kroku 8 flaga `stare` przywraca dzisiejsze działanie. Zadania utworzone w CDC po przełączeniu trzeba
  wtedy przenieść ręcznie (pilot: pojedyncze sztuki), a w CDC wyłączyć `external_channels`.

## 4. Jak to wybuchnie

1. Zapis w CogniFly albo zadanie z webhooka w czasie migracji (dwa źródła).
2. Eskalacje zadań `nowe` z harmonogramem CogniFly: podwójne albo żadne.
3. Podwójne albo brakujące powiadomienia przy przepięciu.
4. Heartwood: stare prace `cognifly:<id>` zostają otwarte z piszącym; nowa praca `cdc:<id>` nie ma piszącego i nikt
   go nie ustawia — znika dzisiejsza ochrona „w plikach zadania pisze tylko właściciel”.
5. Widoczność: CDC pokazuje zadanie także członkom przestrzeni i adminom; skrzynka pokaże więcej niż dziś.
6. Różnice przejść: w CDC `do_akceptacji` tylko z `w_trakcie` (w CogniFly też z `wziete`), `anulowane` jest nowe,
   wykonawca nie-osoba kończy na `do_akceptacji`; aplikacja pokazuje przycisk, który CDC odrzuci.
7. Firma bez licencji `cdc` traci zadania; uśpiona Aurora (0 ACU) odpowiada kilkanaście sekund — aplikacja i hak
   startu (1,5 s) pokazują błąd.
8. Publikacja na szynę Platformy się nie uda (uprawnienia, szyna niedostępna) — zdarzenie jest w `HIST`, zadania nie ma.
9. Stare wersje aplikacji i wtyczki dostają odpowiedź fasady w minimalnie innym kształcie albo nowe kody błędów.
10. Uczestnicy: CogniFly trzyma osoby jako `osobaId`, CDC jako `sub`; przy imporcie i w fasadzie mapowanie się myli.
11. Ludzie w trakcie pracy w oknie migracji; Claude w wątku zadania z nieaktualnym stanem.

## 5. Naprawa

1. Kroki 1–2 i 7 migracji: flaga `przerwa`, zdarzenia czekają w archiwum szyny, odtwarza je skrypt.
2. Krok 3 przed importem; termin eskalacji przenosi import, budzik prowadzi CDC.
3. Krok 6: kolejność z kontraktu (najpierw CDC, potem wyłączenie CogniFly) — świadomie chwilowy dubel.
4. Skrypt migracji zamyka `cognifly:<id>`. Ochrona „pisze tylko właściciel zadania” **znika** zgodnie z decyzją
   Michała, że Heartwood nie zna zadań: zostają zwykłe blokady osób, a zmiany są przypisane do zadania przez
   `--work cdc:<id>`. **Do potwierdzenia przez Michała.**
5. Fasada zawęża `/skrzynka` do zadań, w których osoba jest właścicielem, kandydatem, akceptującym albo nadawcą
   odrzuconego (`mine=1` daje dokładnie to). Szersza widoczność zostaje w MCP CDC.
6. Fasada przekazuje odmowę CDC jako dzisiejszy błąd przejścia (409 z komunikatem CDC). Nowa wersja aplikacji pokazuje
   przyciski według stanów z kontraktu (bez „do akceptacji” z `wziete`); `anulowane` pokazuje jak `usuniete`.
7. Fasada: 403 `BRAK_LICENCJI` z jasnym komunikatem; limit czasu 25 s (API Gateway 30 s); aplikacja ponawia 503/504;
   hak startu przy przekroczeniu nic nie pisze (jak dziś bez sieci). Rozgrzewanie Aurory świadomie zostawione (koszt).
8. Konektor zapisuje w `HIST`, czy publikacja się udała; nieudane odtwarza skrypt `odtworz-zdarzenia` (ręcznie).
   Automatu świadomie nie ma.
9. Kontraktowe testy fasady: odpowiedzi porównywane z typami z `wspolne/src/api.ts`.
10. Fasada i import mapują `osobaId ↔ sub` przez `KONF/OSOBA#.sub` (jest dziś); osoba bez `sub` zatrzymuje import błędem.
11. Okno migracji zapowiedziane Michałowi i Szymonowi; minuty. Wątki Claude (`WATEK#`) zostają, skill po przełączeniu
    czyta stan z CDC.

Świadomie zostawione: rozgrzewanie Aurory, automatyczne wykrywanie nieopublikowanych zdarzeń, automatyczne wycofanie
zadań z CDC, przeniesienie konektora GitHub do osobnego komponentu (na razie kod w CogniFly, rola już osobna).

## 6. Zależności i kolejność

1. CDC: API zadań, silnik reguł i skrzynka powiadomień na teście (sesja CDC, migracja 004).
2. Potwierdzenie z sesją CDC: trasa REST skrzynki powiadomień dla aplikacji (lista nieprzeczytanych, oznaczanie
   przeczytanych) — w kontrakcie nazwana tylko narzędziem MCP `powiadomienia_lista`.
3. CogniFly: fasada, konektor na szynie Platformy, licznik „C”, przyciski według stanów CDC, skrypt migracji — PR do
   `sweter54/CogniFly`, nowa wersja aplikacji i wtyczki.
4. Migracja pilota w oknie; wdrożenia AWS tylko po „tak” Michała.
