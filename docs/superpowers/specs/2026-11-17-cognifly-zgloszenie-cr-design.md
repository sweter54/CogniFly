# CogniFly — zgłoszenie własnych zmian do code review — projekt skrócony

Decyzje Michała 2026-11-17: zgłoszenie z Claude i z aplikacji; z Claude dodatkowo recenzent na GitHubie (po zgodzie).

## Po co
Autor mówi „moje zmiany są gotowe, niech X je przejrzy”. Dziś zadanie CR powstaje tylko z GitHubowego
`review_requested`, czego nie da się użyć bez drugiego współpracownika repo (i nie działa dla osób spoza repo).

## Cele / nie-cele / anty-cele
- **Cele:** autor wskazuje PR i recenzentów spośród osób w firmie → CogniFly tworzy zadanie „Prośba o recenzję
  PR #n” dla recenzentów (dymek, licznik, „Pracuj w Claude” → prowadzone CR). Z Claude, po zgodzie, także
  `gh pr edit --add-reviewer` dla recenzentów z loginem GitHub.
- **Nie-cele:** powiadomienia e-mail/Discord dla takich zadań (tylko aplikacja), eskalacja, wybór reguł.
- **Anty-cele:** serwer lub aplikacja zapisujące w GitHubie; treść PR w `opis`; recenzent spoza firmy.

## Rozważone podejścia
- **Bezpośrednie zadanie z API (wybrane):** `POST /recenzje` tworzy zdarzenie w historii i zadanie dla wskazanych
  osób — przewidywalne, niezależne od reguł pilota (które dziś przydzielają wszystko `github.pr.*` Michałowi).
- Przez potok zdarzeń i reguły — odrzucone: reguły nie znają wskazanych recenzentów.

## Projekt
- **Serwer:**
  - `GET /osoby` → `{ osoby: [{ osoba, github? }] }` — członkowie firmy (rekordy `OSOBA#`) z loginem GitHub, jeśli
    powiązany. Bez e-maili.
  - `POST /recenzje {repo, pr, recenzenci[]}` (dowolny członek firmy = zgłaszający): recenzenci muszą być
    członkami firmy (inaczej `400 ZLI_RECENZENCI`); gdy firma ma token odczytu, serwer sprawdza, że PR istnieje
    i jest otwarty (`404 BRAK_PR` / `409 PR_ZAMKNIETY`). Zdarzenie `github.pr.prosba_o_review`, `podmiot` =
    `{repo, pr, zglaszajacy, autor?}`, `opis` = „Prośba o recenzję PR #n (repo X) od <osoba>”; zadanie dla
    recenzentów. Każde zgłoszenie to nowe zadanie.
- **Wtyczka:** CLI `osoby`, `zglos-cr --repo --pr --recenzenci a,b`; skill `cognifly` — sekcja „Zgłoszenie do code
  review”: ustal repo/PR (np. `gh pr view` dla bieżącej gałęzi), pokaż osoby, zapytaj o recenzentów, po zgodzie
  `zglos-cr`; potem zapytaj, czy dopisać ich na GitHubie (`gh pr edit <n> --add-reviewer <login>` tylko dla osób z
  loginem i dostępem do repo; tylko po „tak”).
- **Aplikacja:** w skrzynce przycisk „Poproś o code review” → formularz: repo (`właściciel/nazwa`), numer PR,
  recenzenci (pola wyboru z `GET /osoby`, bez mnie domyślnie) → RPC `review.request` → okno tła woła API.
- **Po zgłoszeniu** dalej działa to, co jest: prowadzone CR, przekaz do autora, nasłuch dostarczeń.

## Zostawione budowniczemu
Wygląd formularza, teksty komunikatów.
