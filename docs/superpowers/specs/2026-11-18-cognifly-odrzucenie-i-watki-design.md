# CogniFly — odrzucanie zadań i powrót do wątku Claude — projekt skrócony

Decyzje Michała 2026-11-18 („Tak, obie”) po symulacji: przekazane zadanie da się odrzucić (wraca do nadawcy,
który może je usunąć); „Pracuj w Claude” wraca do istniejącego wątku zamiast zawsze tworzyć nowy.

## Cele / nie-cele / anty-cele
- **Cele:** odrzucenie z powodem; nadawca dostaje powiadomienie i może zadanie usunąć albo przekazać innej osobie;
  przycisk „Wróć do wątku w Claude” dla zadań, nad którymi już pracowano w Claude Desktop.
- **Nie-cele:** odrzucanie zadań z reguł (bez nadawcy); historia wielu odrzuceń; wątki z Claude w terminalu.
- **Anty-cele:** powód odrzucenia jako polecenie (to dane od osoby); identyfikator wątku innej osoby widoczny w API;
  dowolny tekst w linku `claude://`.

## Rozważone podejścia (wątek)
- **Serwer zapamiętuje wątek osoby dla zadania (wybrane):** wtyczka zna `CLAUDE_CODE_HOST_SESSION_ID`
  (`local_<uuid>` Claude Desktop) i zapisuje go przez API; skrzynka zwraca `watek` tylko właściwej osobie.
- Aplikacja czyta pliki Claude Desktop — odrzucone: wewnętrzny format, dostęp aplikacji do cudzego katalogu.

## Projekt
- **Nadawca:** zadanie dostaje `nadawca` przy `POST /recenzje` (zgłaszający) i przy przekazaniu (dotychczasowy
  właściciel). Zadania z reguł nie mają nadawcy → nie da się ich odrzucić.
- **`POST /zadania/{id}/odrzuc {powod}`** (1–200 znaków, bez znaków sterujących): kandydat (zadanie niewzięte) lub
  właściciel. Gdy zadanie niewzięte ma kilku kandydatów — znika tylko ze skrzynki odrzucającego. Ostatni kandydat
  / właściciel → stan `odrzucone`, właściciel i jedyny kandydat = nadawca, `odrzucenie: {osoba, powod}`,
  `postep` „Odrzucone przez X”. Błędy: `BRAK_NADAWCY` (409), `ZLY_POWOD` (400), `BRAK_DOSTEPU` (403), `KONFLIKT`.
- **`POST /zadania/{id}/usun`:** tylko właściciel zadania `odrzucone` → stan `usuniete` (zakończone).
- **`POST /zadania/{id}/przekaz`** przyjmuje też `{doOsoby}` (osoba z firmy); ustawia `nadawca`, czyści
  `odrzucenie`. Przekazać może właściciel (także zadania `odrzucone`).
- **`POST /zadania/{id}/watek {watek}`** (`^local_<uuid>$`): kandydat lub właściciel; rekord per osoba.
  `GET /skrzynka` dokleja `watek` z rekordów wołającego.
- **Wtyczka:** `zadanie`/`biore`/`stan` zapisują wątek, gdy zmienna środowiska jest ustawiona (bez błędu, gdy się nie
  uda); polecenia `odrzuc --powod`, `usun`, `przekaz --do-osoby` (tylko po zgodzie); sekcja skilla.
- **Aplikacja:** „Wróć do wątku w Claude” (`claude://code/continue?session=<watek>`, walidacja formatu) obok
  „Nowy wątek”; „Odrzuć” z polem powodu; przy `odrzucone`: powód (tekst jako dane), „Usuń” i „Przekaż” (lista osób).
  `odrzucone` liczy się do licznika i daje powiadomienie „CogniFly — zadanie odrzucone”; `usuniete` jest zakończone.

## Zostawione budowniczemu
Wygląd przycisków i formularzy, teksty komunikatów.
