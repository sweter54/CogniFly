# CogniFly — prowadzone code review i łańcuchy dostarczeń — projekt

Wymagania Michała 2026-11-16; decyzje: nasłuch na serwerze, zależności „oba sposoby”, dostęp serwera do GitHuba
służy do ustalania łańcuchów dostarczeń (token tylko do odczytu — wybór spisującego).

## Po co
CR w Claude ma być procesem, nie luźną rozmową: komentarze przypięte do linii, decyzja oparta na CI, gałęzi
docelowej i zależnościach, każdy komentarz omówiony z człowiekiem, jasny werdykt. Po akceptacji CogniFly sam
pilnuje, kiedy zmianę (i cały łańcuch zależnych zmian) da się dostarczyć; po odrzuceniu zadanie wraca do autora.

## Cele / nie-cele / anty-cele
- **Cele:** (A) prowadzone CR w skillu `github` z mechanicznie wymuszanymi predykatami; komenda „wyślij komentarz”;
  przekazanie zadania autorowi. (B) serwerowy nasłuch dostarczeń z łańcuchami zależności i zadaniem „Dostarcz”.
- **Nie-cele:** automatyczne scalanie przez serwer; GitLab; CR bez człowieka.
- **Anty-cele:** wysłanie choćby jednego komentarza bez omówienia; zapis w GitHubie bez komendy człowieka;
  serwer z prawem zapisu w GitHubie; treść PR (tytuły, opisy, komentarze) w `opis` zadań lub dymkach.

## Rozważone podejścia (nasłuch)
- **Serwer (wybrane):** webhooki + odczyt GitHuba tokenem tylko do odczytu; działa przy zamkniętym Macu, aplikacja bez tokenu.
- Aplikacja na Macu (token GitHuba w aplikacji, tylko gdy Mac włączony) — odrzucone.
- Proces w sesji Claude (żyje tylko z sesją) — odrzucone.

## Część A — prowadzone CR (wtyczka)
Nowy skrypt `wtyczka/skills/github/skrypty/cr.mjs` (Node, bez zależności, `gh` bez powłoki), szkic recenzji w
`~/.cognifly/cr/<owner>_<repo>_<pr>.json` (600, te same zabezpieczenia co sesja). Podpolecenia:

1. `kontekst --repo --pr` → autor, gałąź docelowa (`base`) i jej stan CI, `head` i stan CI (check-runs +
   statusy), `mergeable`, łańcuch zależności (patrz B: ta sama funkcja parsowania), diff z numerami linii.
2. `dodaj --plik --linia [--strona RIGHT|LEFT] --tresc` → propozycja komentarza; **linia musi należeć do diffu**
   (inaczej `LINIA_POZA_DIFFEM`).
3. `omow --nr N --decyzja zostaw|zmien|usun [--tresc]` → zapis decyzji człowieka dla komentarza.
4. `werdykt --akceptuj|--zmiany --podsumowanie <tekst>` → **odmowa (`NIEOMOWIONE`, lista numerów), dopóki
   choć jeden komentarz nie ma decyzji**.
5. `wyslij` (wyłącznie z komendy `/cognifly:wyslij-komentarz` — wywołanie komendy przez człowieka to zgoda):
   wymaga werdyktu i kompletu omówień; wysyła **jedną recenzję** `POST /repos/…/pulls/{n}/reviews`
   (`APPROVE` / `REQUEST_CHANGES`, `body` = podsumowanie, `comments` = zostawione/zmienione z `path`/`line`/`side`).
   Własny PR → GitHub nie pozwala na APPROVE/REQUEST_CHANGES → `COMMENT` + informacja.
   Potem CogniFly: `--zmiany` → `przekaz` zadania autorowi; `--akceptuj` → zadanie CR `zrobione` + rejestracja
   nasłuchu dostarczenia.

Skill `github` dostaje sekcję „Prowadzone CR” z kolejnością kroków i zasadą: **omawiasz komentarze po jednym,
czekasz na decyzję, nie łączysz, nie pomijasz**; przed werdyktem pokazujesz CI, gałąź docelową i łańcuch.
Komenda `wtyczka/commands/wyslij-komentarz.md` uruchamia `cr.mjs wyslij` i pokazuje wynik.

## Część B — serwer: przekazanie i łańcuchy dostarczeń
- **Mapowanie GitHub → osoba:** rekord firmy `GITHUB#<login>` → `osobaId` (ustawia admin; skrypt zasiewu
  `--github-michal <login>`).
- **`POST /zadania/{id}/przekaz {doLoginu}`** (właściciel zadania): zadanie → `nowe`, kandydaci = osoba autora,
  bez właściciela, `postep` = „Uwagi z code review do poprawy”. Autor spoza CogniFly → `409 BRAK_OSOBY`.
- **`POST /dostarczenia {repo, pr, zadanieId}`** (właściciel zadania CR): rejestruje nasłuch PR.
- **Token** tylko do odczytu w Secrets Manager (`cognifly-test/github-odczyt`): CDK tworzy pusty sekret i daje
  Lambdzie prawo odczytu; wartość wpisuje Michał we własnym terminalu (ukryte wpisywanie) — token nigdy nie
  przechodzi przez rozmowę z Claude'em. Brak wartości → ocena kończy się `BRAK_TOKENU` (log), nic nie pada.
- **Zdarzenia:** webhook dodatkowo przyjmuje `check_suite`, `check_run`, `status`, `pull_request`
  (`synchronize`, `edited`, `closed`), które dla obserwowanych PR (i ich zależności) uruchamiają ocenę;
  plus harmonogram co 10 min (zależności z repo bez webhooka).
- **Ocena (czysta funkcja, testowana):** łańcuch = graf zależności (PR nałożony na gałąź innego otwartego PR +
  linie `Zależy od: #12, org/repo#34` w opisie PR, rekurencyjnie, wykrywanie cykli → `CYKL`). PR **gotowy**, gdy:
  otwarty, zaakceptowany, bez konfliktów (`mergeable`), CI dla `head` zielone (wszystkie check-runy i statusy
  zakończone sukcesem; brak CI = zielone), wszystkie zależności scalone. Wynik: `gotowe` / `czeka` z powodami
  (`CI_W_TOKU`, `CI_BLAD`, `KONFLIKT`, `CZEKA_NA <pr>`, `CYKL`).
- **Gotowe** → zadanie „Dostarcz PR #12 (repo) — CI zielone, zależności scalone” (`opis` z pól strukturalnych)
  dla **autora PR i recenzenta, który zaakceptował** (decyzja Michała: kto pierwszy „Biorę”, ten scala; autor
  spoza CogniFly → tylko recenzent) → dymek w aplikacji → „Pracuj w Claude” → skill: `gh pr merge` z metodą wybraną przez człowieka (spośród
  dozwolonych w repo), tylko po zgodzie. Scalenie (`pull_request.closed`, `merged`) → nasłuch zakończony,
  zależne PR w łańcuchu oceniane ponownie (łańcuch idzie dalej).

## Decyzje spisującego po przeglądzie (do sprawdzenia przez Michała)
1. **„Zaakceptowany”** = akceptacja zapisana przez CogniFly przy `wyslij --akceptuj` **dla konkretnego `head` sha**
   (działa też dla własnego PR, gdzie GitHub dostaje tylko `COMMENT`). Dodatkowo, gdy repo wymaga recenzji
   (ochrona gałęzi), GitHubowe `reviewDecision` musi być `APPROVED`. Nowy commit po akceptacji → `NOWY_COMMIT`
   (czeka na ponowne CR); późniejsze `REQUEST_CHANGES` kogokolwiek → `ZMIANY_ZADANE`.
2. **Zdarzenia CI omijają potok zdarzeń** (nie trafiają do historii ani reguł): webhook rozpoznaje `check_suite`,
   `check_run`, `status` i zmiany PR dla obserwowanych PR i przekazuje je wprost do oceny dostarczeń. Rekord
   nasłuchu trzyma `head` sha → wyszukanie po sha dla `status`. `pull_request.edited/closed` też nie tworzą zdarzeń.
3. **Cykl życia:** po `przekaz` autor poprawia; push → istniejąca reguła tworzy zadanie „commit po review” →
   nowe CR. Nasłuch istnieje tylko dla zaakceptowanych PR. Zadanie „Dostarcz” — jedno na PR (idempotentne id
   z repo+PR+sha akceptacji); gdy PR przestanie być gotowy, zadanie zostaje, a skill przed scaleniem zawsze
   sprawdza gotowość ponownie i mówi, co blokuje.
4. **Token per firma:** `cognifly-test/github-odczyt/<firma>` (jak sekrety webhooków). Zależność, której token nie
   widzi (404/403) → `ZALEZNOSC_NIEDOSTEPNA` (czeka; nigdy nie uznawana za scaloną).
5. **Twarda bramka „wyślij”:** komenda `/cognifly:wyslij-komentarz` ma `disable-model-invocation: true` i uruchamia
   `cr.mjs wyslij` w kroku wykonywanym przez Claude Code przy wpisaniu komendy (przed modelem). Hook wtyczki
   `PreToolUse` **blokuje** każde wywołanie `cr.mjs wyslij` przez narzędzie Bash modelu. Model fizycznie nie wyśle recenzji.
6. **Powiązanie z zadaniem:** `cr.mjs kontekst --zadanie zad_…` (z „Pracuj nad zadaniem”); bez zadania CR działa,
   a kroki CogniFly (przekaz, nasłuch) są pomijane z informacją.

## Ograniczenia
Konto testowe, `eu-central-1`, konwencje planu 1; nowy kod po angielsku z opisami funkcji tam, gdzie moduł jest
nowy (rozszerzane moduły serwera/wtyczki zachowują polskie nazewnictwo); `npm test` zielony; wdrożenia po zgodzie.

## Zostawione budowniczemu
Kształt pliku szkicu, dokładne teksty, interwał harmonogramu (10 min jako punkt wyjścia).
