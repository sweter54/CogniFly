# CogniFly jako klient zadań CDC (projekt)

Data: 2026-11-22. Status: projekt do akceptacji Michała. Implementacja dopiero po akceptacji i po kontrakcie cyklu
życia zadań od sesji CDC (`docs/superpowers/specs/2026-11-20-cdc-design.md` w repo CDC, rozdz. zadań).

Decyzja Michała (2026-11-22): właścicielem zadań i ich cyklu życia jest CDC. CogniFly zostaje nakładką:
powiadomienia, aplikacja, skille i stan pracy na maszynie.

## 0. Inwentaryzacja: co CogniFly dziś trzyma i robi sam

Jedna tabela DynamoDB `cognifly-test-dane`. Los każdej pozycji: **CDC** (przechodzi do CDC), **zostaje**
(CogniFly, jako własny stan lub kopia odtwarzana z CDC), **znika**.

| Pozycja | Dziś (klucz / kod) | Los |
|---|---|---|
| Zadanie | `FIRMA#f#ZAD / zad_id`, `serwer/src/dane/kolejka.ts` | **CDC** (`tasks`) |
| Wpis skrzynki kandydata | `FIRMA#f#SKR#osoba`, GSI1 `OSOBA#…` | **znika** (skrzynka = zapytanie do CDC) |
| Stany `nowe…usuniete`, „biorę” (zapis warunkowy, 409 `ZAJETE`) | `kolejka.ts` | **CDC** (te same stany; `usuniete` → `deleted_at`) |
| Przekaż (do osoby / do loginu GitHub) | `przekaz` | **CDC** (przejście); rozwiązanie loginu GitHub → osoby **zostaje** w CogniFly |
| Odrzuć (także „odejście” jednego z kilku kandydatów), usuń odrzucone | `odrzuc`, `odejdzKandydat`, `usunOdrzucone` | **CDC** |
| Akceptacja (`do_akceptacji` z akceptującym, `akceptuj`, `do-poprawy` z uwagami) | `ustawStan`, `rozstrzygnij` | **CDC** |
| Eskalacja (EventBridge Scheduler `at(+N min)`, `eskalujDo`, Lambda `Eskalacja`) | `przetwarzanie/obsluz.ts`, `eskalacja/` | **CDC** (zegar i przejście `nowe → eskalowane`); powiadomienie o eskalacji **zostaje** |
| Silnik reguł (zdarzenie → kandydaci, powiadom, `eskalacjaMin`, role) | `reguly/silnik.ts`, `KONF/REGULA#`, `KONF/ROLA#` | **CDC** (część kontraktu); reguły pilota przenoszone migracją |
| Deduplikacja zdarzeń (`evt_` z sha256 klucza zewnętrznego, znacznik `EVT` 90 dni) | `historia.ts`, `wspolne/src/zdarzenie.ts` | **zostaje** dla wejścia GitHub (nie wysyłać dwa razy); **CDC** musi mieć idempotentne tworzenie zadania (klucz zewnętrzny) |
| Historia zdarzeń (`HIST`, 90 dni, `GET /zdarzenia`) | `historia.ts` | **zostaje** (dziennik wejścia: push, PR — nie wszystkie zdarzenia są zadaniami); historia zadań → `task_events` w **CDC** |
| Webhook GitHub (HMAC, mapowanie na `github.pr.*`) | `wejscie/github.ts`, `mapuj-github.ts` | **zostaje** (wejście); zdarzenie idzie na hub, zadanie tworzy **CDC** |
| Prowadzone CR (`POST /recenzje`: sprawdzenie PR, recenzenci z firmy) | `api/recenzje.ts` | sprawdzenie GitHuba **zostaje**; zadanie tworzy **CDC** |
| Łańcuchy dostarczeń (obserwacja PR, ocena GraphQL, zamiatanie co 10 min) | `dostarczenia/*`, `FIRMA#f#DOST`, `REJESTR#DOSTARCZENIA` | **zostaje** (integracja GitHub); zadanie „Dostarcz PR” tworzy **CDC**; obserwacja wskazuje zadanie CDC |
| Powiadomienia e-mail / Discord | `powiadomienia/*`, `KONF/KONTAKT#` | **zostaje** (CogniFly = powiadamiacz), wyzwalane zdarzeniami CDC z huba |
| Wątek Claude Desktop przy zadaniu | `FIRMA#f#WATEK#osoba`, `POST /watek` | **zostaje** (stan na maszynie osoby) |
| Login GitHub → osoba | `KONF/GITHUB#` | **zostaje** |
| Rejestr osób, profil, licencja | `KONF/OSOBA#`, `OSOBA#sub/PROFIL` | **zostaje** (kopia z Tożsamości; poza zakresem) |
| Stan pracy w Heartwood (`cognifly:<zad>`, strumień DynamoDB → `PUT /int/.../work`) | `heartwood/praca.ts`, `strumien.ts` | **CDC** (praca `cdc:<id>` wg specu CDC rozdz. 15); strumień CogniFly **znika** |
| Zadania z Heartwood (`pliki.blokada.prosba`, konflikt, limit) | `heartwood/zdarzenia.ts` | **CDC** (reguły na zdarzeniach `heartwood`); powiadomienia **zostają** |
| Pliki zadania (`GET /zadania/{id}/pliki`, MCP `pliki_zadania` itd.) | `api/pliki.ts`, `wtyczka/mcp` | **zostaje** (odczyt z Heartwood, id pracy `cdc:<id>`) |

## 1. Cele

1. Jedno źródło prawdy o zadaniach: CDC. Po przejściu CogniFly nie ma rekordu zadania, który mógłby się rozjechać z CDC.
2. Zdarzenie z GitHuba (PR: prośba o review, review, commit po review, gotowy do dostarczenia) tworzy zadanie w CDC.
3. Aplikacja Tauri, CLI, wtyczka (skille, hook startu, MCP) działają dla osoby tak jak dziś: skrzynka, „biorę”,
   stany, przekaż, odrzuć, akceptacja, powiadomienia, pliki zadania.
4. Zadania pilota (otwarte i historia) są w CDC z tymi samymi identyfikatorami, a praca w Heartwood dalej je widzi.

Po czym poznamy: test dymny na `pilot` — webhook GitHub → zadanie widać w `zadania_lista` (MCP CDC) i w aplikacji
CogniFly; przychodzi e-mail o nowym zadaniu; „biorę” w aplikacji zmienia stan w CDC; zadanie testowe z eskalacją
1 min przechodzi w `eskalowane` i przychodzi powiadomienie; tabela CogniFly nie ma rekordów `ZAD`/`SKR` pisanych po
przejściu.

## 2. Wymagania

- R1. CogniFly czyta i zmienia zadania wyłącznie przez API CDC, tokenem osoby (klient `cognifly` jest dopuszczony
  w CDC) albo jako maszyna dla zadań systemowych.
- R2. Publiczne API CogniFly (`/skrzynka`, `/podsumowanie`, `/zadania/{id}…`, `/recenzje`, `/dostarczenia`) zostaje
  z tym samym kształtem udanych odpowiedzi (pola typów `wspolne/src/api.ts`, w tym `zdarzenieId`), żeby stare wersje
  aplikacji i wtyczki działały. Dochodzą dwa kody błędów (503 `PRZERWA`, 403 `BRAK_LICENCJI` od CDC); stare wersje
  pokażą je jako zwykły błąd — to akceptujemy.
- R3. CDC zapewnia (kontrakt, do potwierdzenia z sesją CDC): stany i przejścia jak dziś w CogniFly (w tym
  odejście kandydata, przekaż z nowym nadawcą, akceptujący domyślnie = nadawca), eskalację czasową z `eskalujDo`,
  silnik reguł zdarzenie → zadanie, idempotentne tworzenie zadania po kluczu zewnętrznym, zdarzenia na hubie przy
  zmianach zadań, sterowanie pracą Heartwood, import zadań z zachowaniem id, stanu, historii i terminu eskalacji,
  oraz w REST listę „zadania dla mnie” (właściciel, kandydat, akceptujący, odrzucone moich zleceń) — dziś w REST CDC
  jest tylko `owner=me`.
- R4. Powiadomienia e-mail/Discord i powiadomienia aplikacji wynikają ze zdarzeń CDC.
- R5. Migracja pilota jednorazowa, z krótkim oknem bez zapisów, bez utraty zadań i eskalacji.

## 3. Najprostsze rozwiązanie

- **Fasada.** Serwer CogniFly zostaje pod tymi samymi trasami. Trasy zadań przekazują żądanie do CDC
  (`/orgs/{org}/tasks…`) z tokenem osoby i tłumaczą odpowiedź na dzisiejszy kształt `Task`. Bez własnej kopii zadań.
  Skrzynka = lista „zadania dla mnie” z CDC (wymaganie R3).
- **Wejście GitHub.** Webhook zostaje w CogniFly (HMAC, mapowanie, deduplikacja wejścia). Zmapowane zdarzenie idzie na
  hub Platformy (`source=cognifly.github`, z id `evt_…`). CDC ma regułę na hubie: silnik reguł tworzy zadanie
  idempotentnie (klucz = id zdarzenia). Tak samo zdarzenia Heartwood: konsumuje je CDC.
- **Prowadzone CR i dostarczenia.** CogniFly sprawdza GitHuba jak dziś i tworzy zadanie w CDC z kluczem zewnętrznym
  = dzisiejszy klucz zdarzenia. Prośbę o CR tworzy tokenem osoby zgłaszającej (ona jest nadawcą); zadanie „Dostarcz PR”
  tworzy jako maszyna, bo nikt go nie zleca. Obserwacja PR zapisuje id zadania CDC.
- **Powiadomienia.** Lambda CogniFly słucha zdarzeń CDC na hubie (`task.created`, `task.escalated`,
  `task.state_changed` …) i wysyła e-mail/Discord według `KONTAKT#`. Aplikacja dalej odpytuje `/skrzynka` co 60 s.
- **Usunięte z CogniFly:** zapisy `ZAD`/`SKR`, `kolejka.ts`, silnik reguł i `REGULA#`/`ROLA#`, harmonogramy eskalacji
  i Lambda `Eskalacja`, strumień DynamoDB i Lambda `HeartwoodPraca`, konsument zdarzeń Heartwood tworzący zadania.
- **Migracja pilota.** Źródłem są rekordy `ZAD` (zdarzenie zadania dociągane po `zdarzenieId`, jak dziś
  `zdarzenieZadania`); reguły i role → konfiguracja reguł CDC. Jedna kolejność, obowiązująca w całym dokumencie:
  1. Wdrożenie CogniFly z flagą `ZADANIA_W_CDC=przerwa|cdc|stare` (SSM). Nowy kod i stary kod w jednym wydaniu.
  2. Flaga `przerwa`: trasy zapisu zadań → 503 `PRZERWA`; webhook dalej przyjmuje i zapisuje w `HIST`, ale nie
     tworzy zadań (zdarzenia zostają w archiwum szyny `cognifly-test`). Strumień `HeartwoodPraca` wyłączony — w tym
     oknie nikt nie zmienia zadań, więc nie ma czego synchronizować.
  3. Usunięcie grupy harmonogramów `cognifly-test-eskalacje`.
  4. Import do CDC: id, stan, uczestnicy, historia, `eskalujDo`, termin eskalacji (`utworzono + eskalacjaMin` dla
     zadań `nowe`); od tej chwili zegar eskalacji prowadzi CDC. Import zamyka pracę `cognifly:<id>`, a CDC otwiera
     `cdc:<id>` z tym samym piszącym.
  5. Flaga `cdc`: fasada, konsument zdarzeń CDC (powiadomienia), webhook → hub. Stara ścieżka powiadomień z reguł
     jest wyłączona tą samą flagą.
  6. Skrypt odtwarza z archiwum szyny zdarzenia z okna `przerwa` na hub (CDC tworzy zadania idempotentnie).
  7. Test dymny (rozdz. 1). Po tygodniu bez problemów: usunięcie starego kodu i zasobów.
  Tabela zostaje (RETAIN), rekordy `ZAD` tylko do odczytu.
- **Wycofanie:** do kroku 7 flaga `stare` przywraca dzisiejsze działanie na rekordach `ZAD`. Zadania utworzone w CDC
  po przełączeniu trzeba wtedy przenieść ręcznie (pilot: pojedyncze sztuki) — świadomie bez automatu.

## 4. Jak to wybuchnie

1. **Dwa źródła w czasie przejścia:** zapis w CogniFly po imporcie albo zadanie z webhooka w oknie migracji.
2. **Zgubione eskalacje:** zadania `nowe` z zaplanowanym harmonogramem CogniFly po imporcie — eskalują podwójnie albo wcale.
3. **Podwójne powiadomienia:** stara ścieżka (reguła → powiadom) i nowa (zdarzenie CDC → powiadom) naraz.
4. **Podwójne sterowanie Heartwood:** strumień CogniFly i CDC ustawiają tę samą pracę różnie; stare `cognifly:<id>`
   zostają otwarte i trzymają blokady.
5. **Uprawnienia się różnią:** CogniFly pokazuje zadanie tylko uczestnikom; CDC także członkom przestrzeni i adminom
   — skrzynka pokaże za dużo albo `szczegoly` przepuści kogoś, komu dziś odmawia.
6. **Różnice semantyki:** odejście jednego z kilku kandydatów, akceptujący domyślnie = nadawca, `przekaz` zerujący
   uwagi/akceptującego, `usuniete` jako stan — CDC robi inaczej i aplikacja się myli.
7. **Token:** CDC odrzuca token klienta `cognifly` albo wymaga `/access?product=cdc` — firma bez licencji CDC traci zadania.
8. **CDC niedostępne / uśpiona Aurora (0 ACU):** pierwsze żądanie po godzinie czeka kilka–kilkanaście sekund; aplikacja
   (limit czasu) i hook startu (1,5 s) pokażą błąd.
9. **Webhook zgubiony między CogniFly a CDC:** hub/reguła CDC padnie, zdarzenie jest w historii CogniFly, zadania nie ma.
10. **Stare wersje klientów:** kształt odpowiedzi fasady minimalnie inny (np. brak `zdarzenieId`) i stara aplikacja pada.
11. **Kolizja id:** id zadań CogniFly (`zad_<12|24 hex>`) i CDC w jednej przestrzeni nazw.
12. **Ludzie:** Michał/Szymon w trakcie pracy w oknie migracji; Claude w wątku zadania z nieaktualnym stanem.

## 5. Naprawa (najmniejsza zmiana na każdy punkt)

1. Flaga `ZADANIA_W_CDC` i kroki 1–2 i 6 migracji (rozdz. 3): w oknie nic nie pisze zadań, zdarzenia czekają
   w archiwum szyny i odtwarza je skrypt migracji.
2. Kroki 3–4 migracji: harmonogramy CogniFly usunięte przed importem, termin eskalacji przenosi import, liczy i
   wykonuje CDC.
3. Krok 5 migracji: obie ścieżki powiadomień przełącza jedna flaga.
4. Kroki 2 i 4 migracji: strumień wyłączony w oknie, import zamyka `cognifly:<id>`, CDC otwiera `cdc:<id>`.
   Zgłosić sesji CDC jako wymaganie importu.
5. Widoczność w aplikacji zostaje dzisiejsza (uczestnik: właściciel, kandydat, nadawca, akceptujący) — to decyzja
   produktu CogniFly, nie łatanie CDC: CDC i tak sprawdza dostęp po swojej stronie, fasada tylko zawęża listę.
   Szersza widoczność jest w MCP CDC.
6. Różnice w przejściach (odejście kandydata, akceptujący domyślny itd.) idą do sesji CDC jako lista przejść z
   testami z `kolejka.test.ts`; fasada nie dorabia przejść po swojej stronie.
7. Warunek wejścia: CDC przyjmuje klienta `cognifly`; firma bez licencji CDC → fasada zwraca 403 `BRAK_LICENCJI`
   z jasnym komunikatem (nie po cichu pustą skrzynkę). Pilot ma licencję `cdc`.
8. Limit czasu fasady 25 s (API Gateway ma 30 s), aplikacja ponawia przy 503/504; hook startu przy przekroczeniu
   nic nie pisze (jak dziś przy braku sieci). Rozgrzewanie Aurory zostawiam świadomie (koszt) — decyzja Michała.
9. Reguła CDC na hubie z DLQ (jest w stosie CDC). Skrypt `sprawdz-zdarzenia` porównuje zdarzenia `github.pr.*` z `HIST`
   z ostatnich N dni z zadaniami CDC po kluczu zewnętrznym i odtwarza brakujące — uruchamiany ręcznie; automatu
   świadomie nie ma.
10. Kontraktowe testy fasady: odpowiedzi porównywane z dzisiejszymi typami `Task`/`Skrzynka` z `wspolne/src/api.ts`.
11. Import zachowuje id. Nowe id CDC: `zad_` + 24 losowe znaki hex; prawdopodobieństwo kolizji pomijalne, a
    unikalny klucz w CDC zamienia kolizję w głośny błąd importu, nie w nadpisanie.
12. Okno migracji zapowiedziane Michałowi i Szymonowi; trwa minuty (dane pilota: kilka osób, kilkadziesiąt zadań).
    Wątki Claude zostają (`WATEK#`), skill po przełączeniu czyta stan z CDC.

Świadomie zostawione: rozgrzewanie Aurory (pkt 8), szersza widoczność zadań w aplikacji (pkt 5), automatyczne
wykrywanie zgubionych zdarzeń (pkt 9), automatyczne wycofanie zadań utworzonych w CDC (rozdz. 3), przeniesienie
kontaktów powiadomień (`KONTAKT#`) do CDC — osobny krok, gdy CDC przejmie konfigurację kanałów.

## 6. Zależności i kolejność

1. Kontrakt cyklu życia od sesji CDC (R3), zaakceptowany przez Michała.
2. CDC: reguły na hubie, import, praca Heartwood `cdc:<id>`, zdarzenia zadań na hubie.
3. CogniFly: fasada + konsument powiadomień + wejście GitHub na hub (PR do `sweter54/CogniFly`, nowa wersja aplikacji
   i wtyczki — kształt API bez zmian, więc nowe wersje głównie dla komunikatów `PRZERWA`/`BRAK_LICENCJI`).
4. Migracja pilota w oknie, potem usunięcie martwego kodu i zasobów (Lambdy `Eskalacja`, `HeartwoodPraca`, grupa
   harmonogramów). Wdrożenia AWS tylko po „tak” Michała.
