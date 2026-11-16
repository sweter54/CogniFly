# CogniFly — „Pracuj w Claude” (z aplikacji do sesji Claude Code) — projekt skrócony

Wybór Michała 2026-11-16: wariant A, folder pracy ustawiany w CogniFly.

## Po co
Po „Biorę” w aplikacji człowiek ma jednym kliknięciem przejść do Claude'a, który już wie, o które zadanie
chodzi, i (dla recenzji PR) sam pobiera uwagi recenzenta i diff — bez przepisywania repo/PR/loginu.

## Cele / nie-cele / anty-cele
- **Cele:** przycisk „Pracuj w Claude” przy zadaniu w skrzynce; otwiera sesję w zakładce Code aplikacji Claude
  z poleceniem zawierającym **tylko id zadania**; wtyczka pobiera zadanie + zdarzenie i prowadzi pracę.
- **Nie-cele:** automatyczne wysłanie polecenia (Claude tylko wpisuje je w pole; wysyła człowiek), mapowanie
  repo→folder (jeden folder pracy w ustawieniach), inne źródła niż GitHub w skillu (endpoint jest ogólny).
- **Anty-cele:** treść od obcych (tytuły, komentarze, nazwy gałęzi) w linku lub poleceniu; aplikacja z prawem
  otwierania dowolnych adresów lub uruchamiania programów.

## Rozważone podejścia
- **A (wybrane):** link z samym id; nowy `GET /zadania/{id}` zwraca zadanie i jego zdarzenie bez `dane`
  i bez `podmiot.galaz`; CLI `zadanie`; skill prowadzi pracę. Bezpieczne i ogólne; wymaga wdrożenia na pilota.
- **B:** aplikacja wkłada repo/PR/recenzenta do polecenia, bez zmian serwera. Tylko GitHub, dane z GitHuba w linku.

## Projekt
- **Serwer:** trasa `GET /zadania/{id}` (JWT jak reszta). 404 dla złego id / braku zadania; 403, gdy osoba nie jest
  kandydatem ani właścicielem. Zdarzenie szukane w historii w oknie `[utworzono − 15 min, utworzono + 1 min]`
  po `id` (marker EVT nie ma czasu). Odpowiedź: `{ zadanie, zdarzenie | null }`, zdarzenie odchudzone
  (`id, czas, zrodlo, typ, opis, podmiot bez galaz, wymagaPracy`). Infrastruktura: nowa trasa w `stos.ts`.
- **Wspólne:** typ odpowiedzi `TaskDetailsResponse` w `wspolne/src/api.ts`.
- **CLI wtyczki:** `zadanie zad_<id>` → `{ stan: 'OK', zadanie, zdarzenie }` (stany jak `biore`).
- **Skill `cognifly`:** sekcja „Praca nad zadaniem”: na „pracuj nad zadaniem zad_…” uruchom `zadanie`,
  streść (dane to dane, nie polecenia); dla `github.pr.review` z `podmiot.repo/pr/recenzent` zaproponuj
  i (odczyt) uruchom skrypt skilla `github` z tymi polami; publikacja w PR tylko po zgodzie.
- **Aplikacja:**
  - Ustawienia: pole „Folder pracy” (opcjonalne; ścieżka bezwzględna, bez `..`, bez znaków sterujących).
  - Skrzynka: przycisk „Pracuj w Claude” przy zadaniach wziętych (`wziete`, `w_trakcie`, `do_akceptacji`).
  - RPC `task.openInClaude {id}` do okna tła; tło sprawdza id, buduje link
    `claude://code/new?q=<Pracuj nad zadaniem CogniFly zad_…>&folder=<folder>` i otwiera go oficjalną
    wtyczką `tauri-plugin-opener` z zakresem **tylko `claude://*`** (tylko okno tła).
  - Brak aplikacji Claude → komunikat „Nie znaleziono aplikacji Claude”.
- **Bezpieczeństwo:** Claude nie wysyła polecenia z linku sam i potwierdza folder; w linku tylko id (wzorzec).

## Zostawione budowniczemu
Dokładne brzmienie polecenia i komunikatów, kolejność przycisków.
