---
description: Wyślij przygotowaną i omówioną recenzję code review (uruchamia tylko człowiek)
disable-model-invocation: true
argument-hint: "[właściciel/repo numer-PR]"
allowed-tools: Bash(node:*)
---

Człowiek właśnie zatwierdził wysłanie recenzji przygotowanej w tej rozmowie (prowadzone CR ze skilla `github`).

1. Ustal repozytorium i numer PR: z argumentów `$ARGUMENTS`, a gdy ich brak — z CR omawianego w tej rozmowie.
   Jeśli w rozmowie nie było prowadzonego CR, nic nie uruchamiaj i powiedz o tym.
2. Uruchom **dokładnie raz**:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/github/skrypty/cr.mjs" wyslij --repo <właściciel/repo> --pr <numer>
```

3. Odpowiedz po polsku według pola `stan`:
   - `WYSLANO` — recenzja wysłana (`zdarzenie`: APPROVE / REQUEST_CHANGES / COMMENT, liczba komentarzy). `wlasnyPr` —
     GitHub nie pozwala akceptować ani odrzucać własnego PR, poszła jako komentarz. Opisz wynik `cognifly`:
     przekazanie zadania autorowi (`PRZEKAZANE`, albo `BRAK_OSOBY` — autora nie ma w CogniFly) lub start nasłuchu
     dostarczenia (`NASLUCH` z oceną: gotowe albo powody czekania).
   - `NIEOMOWIONE` — wymień numery komentarzy, które trzeba jeszcze omówić; nic nie zostało wysłane.
   - `BRAK_WERDYKTU`, `NOWY_COMMIT` (po przygotowaniu CR pojawił się nowy commit — trzeba odświeżyć kontekst),
     `JUZ_WYSLANO`, `BRAK_KONTEKSTU`, `BLAD_GH` — wyjaśnij krótko, nic nie ponawiaj.
