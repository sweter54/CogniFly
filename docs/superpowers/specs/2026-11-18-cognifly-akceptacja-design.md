# CogniFly — akceptacja przez wskazaną osobę — projekt skrócony

Decyzja Michała 2026-11-18: „do akceptacji i przez daną osobę i ona dostaje powiadomienie że ma to sprawdzić
i może wysłać do poprawy”.

## Cele / nie-cele / anty-cele
- **Cele:** właściciel przy „Do akceptacji” wskazuje osobę z firmy; ona dostaje powiadomienie, widzi zadanie
  w skrzynce i klika „Akceptuj” (→ zrobione) albo „Do poprawy” z powodem (→ wraca do właściciela, w trakcie).
- **Nie-cele:** wieloetapowa akceptacja, kilku akceptujących, terminy.
- **Anty-cele:** akceptacja własnego zadania; powód poprawki jako polecenie (to dane od osoby).

## Projekt
- `POST /zadania/{id}/stan {stan: 'do_akceptacji', akceptujacy?}` — osoba z firmy, nie właściciel; bez niej
  domyślnie `nadawca`; bez obu → `400 BRAK_AKCEPTUJACEGO`, osoba spoza firmy / właściciel → `400 ZLY_AKCEPTUJACY`.
  Zadanie dostaje `akceptujacy`, osoba trafia do `kandydaci` (wpis w skrzynce, wgląd w szczegóły); `uwagi` znikają.
  Zmiana na inny stan przez właściciela czyści `akceptujacy`.
- `POST /zadania/{id}/akceptuj` (tylko `akceptujacy`, stan `do_akceptacji`) → `zrobione`, postęp „Zaakceptowane przez X”.
- `POST /zadania/{id}/do-poprawy {powod}` (j.w.; powód 1–200 znaków) → `w_trakcie`, `uwagi: {osoba, powod}`,
  postęp „Do poprawy (X)”, bez `akceptujacy`.
- Podsumowanie (hook) liczy zadania do akceptacji przez osobę.
- **Wtyczka:** `stan … do_akceptacji [--akceptujacy <osoba>]`, `akceptuj`, `do-poprawy --powod` (po zgodzie).
- **Aplikacja:** wybór „Do akceptacji” pyta o osobę (lista z `GET /osoby`); u akceptującego „Akceptuj” i „Do poprawy”
  z polem powodu; powiadomienia „CogniFly — do akceptacji” (akceptujący) i „CogniFly — do poprawy” (właściciel);
  oba liczą się do licznika, dopóki ktoś nie zareaguje.

## Decyzje po przeglądzie
- Akceptujący zostaje kandydatem po decyzji: widzi zadanie w „Zakończonych” (jak inni kandydaci po „biorę”).
- Każda runda ma znacznik (`oddano`, `uwagi.czas`), żeby powiadomienie przyszło przy każdej kolejnej rundzie.
- Przekazanie i odrzucenie czyszczą `uwagi` i `akceptujacy`. Właściciel może pominąć akceptację, wybierając inny stan.

## Zostawione budowniczemu
Wygląd, teksty komunikatów.
