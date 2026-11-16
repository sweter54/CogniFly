# Prowadzone CR i łańcuchy dostarczeń — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** CR w Claude z komentarzami w liniach, obowiązkowym omówieniem, werdyktem i bramką „wyślij komentarz”; serwer pilnuje łańcuchów dostarczeń i tworzy „Dostarcz PR”.
**Architecture:** Logika łańcucha i gotowości tylko na serwerze (czyste funkcje w `serwer/src/dostarczenia/`); wtyczka pyta o ocenę przez API. Wtyczka: `cr.mjs` (szkic w `~/.cognifly/cr/`), komenda z `disable-model-invocation`, hook `PreToolUse` blokujący `cr.mjs wyslij` z narzędzia Bash. Zdarzenia CI z webhooka idą osobnym typem EventBridge do Lambdy `Dostarczenia` (+ harmonogram co 10 min).
**Tech Stack:** jak plan 1 (Node 22, TS, DynamoDB, EventBridge, Scheduler, CDK) + `gh` po stronie wtyczki.
**Spec:** `docs/superpowers/specs/2026-11-16-cognifly-prowadzone-cr-design.md`

## Global Constraints
- Zapis w GitHubie wyłącznie z `cr.mjs wyslij` uruchomionego przez komendę człowieka; serwer tylko czyta (token per firma `cognifly-test/github-odczyt/<firma>`, wartość wpisuje Michał).
- `werdykt` i `wyslij` odmawiają (`NIEOMOWIONE`), dopóki każdy komentarz nie ma decyzji; komentarz tylko na linii z diffu (`LINIA_POZA_DIFFEM`).
- Treść PR (tytuł, opis, komentarze) nigdy w `opis` zadań; opis zadania „Dostarcz” z pól strukturalnych.
- Zdarzenia CI nie trafiają do historii ani reguł.
- Nowe moduły po angielsku z opisami funkcji (≤ 20 × 75); rozszerzane moduły zachowują nazewnictwo.
- `npm test` zielony; wdrożenie po zgodzie.

## Review Focus
1. Model próbuje `node cr.mjs wyslij` przez Bash → hook blokuje (test hooka).
2. Komentarz bez decyzji → `werdykt`/`wyslij` odmawia z numerami (test).
3. Cykl zależności A→B→A → `CYKL`, brak zadania „Dostarcz” (test oceny).
4. Nowy commit po akceptacji → `NOWY_COMMIT`, nie „gotowe” (test oceny).
5. Autor spoza CogniFly przy `przekaz` → `409 BRAK_OSOBY`, zadanie bez zmian (test API).

### Task 1: Serwer — mapowanie GitHub→osoba, `POST /zadania/{id}/przekaz`
- [ ] `GITHUB#<login>` w `dane/konfiguracja.ts` (+ zasiew `--github-michal`), `przekaz` w `dane/kolejka.ts` + `api/zadania.ts` + trasa; testy API.
### Task 2: Serwer — ocena dostarczeń (czyste funkcje)
- [ ] `serwer/src/dostarczenia/zaleznosci.ts` (`parseDependsOn(body)`, `stackedOn`), `ocena.ts` (`assessChain(graph) → {ready|waiting, reasons}`), testy z Review Focus 3–4.
### Task 3: Serwer — GitHub (odczyt), nasłuch, `GET /dostarczenia/ocena`, `POST /dostarczenia`, Lambda + harmonogram + zdarzenia CI z webhooka
- [ ] klient GitHub z tokenem z Secrets Manager; rekordy `DOST#<repo>#<pr>`; tworzenie „Dostarcz” dla autora+recenzenta; CDK (Lambda, reguła, harmonogram, pusty sekret, IAM); testy.
### Task 4: Wtyczka — `cr.mjs`, komenda, hook, skill, CLI `przekaz`/`dostarczenia`
- [ ] podpolecenia `kontekst|dodaj|omow|szkic|werdykt|wyslij`, parser hunków diffu, budowa recenzji; `commands/wyslij-komentarz.md`; hook `PreToolUse`; sekcja „Prowadzone CR” i „Dostarczenie” w skillu `github`; testy (`gh` podmieniany jak w `review-dane`).
### Task 5: Wdrożenie i weryfikacja
- [ ] diff + deploy (zgoda), Michał wpisuje token, CR na testowym PR: komentarze w liniach, omówienie, wysłanie, przekaz/„Dostarcz”.
