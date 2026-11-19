# „Pracuj w Claude” Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Z wziętego zadania w aplikacji jednym kliknięciem otworzyć sesję Claude Code, która sama pobiera zadanie.
**Architecture:** Nowy `GET /zadania/{id}` (serwer + trasa CDK) → CLI `zadanie` → skill; aplikacja buduje link `claude://code/new` z samym id i otwiera go wtyczką opener (zakres `claude://*`, tylko okno tła).
**Tech Stack:** jak w planie aplikacji + `tauri-plugin-opener`.
**Spec:** `docs/superpowers/specs/2026-11-16-cognifly-pracuj-w-claude-design.md`

## Global Constraints
- W linku i poleceniu wyłącznie id zadania pasujące do `TASK_ID_PATTERN`.
- Odpowiedź `GET /zadania/{id}` bez `zdarzenie.dane` i bez `podmiot.galaz`; dostęp tylko kandydat/właściciel.
- Opener: tylko `claude://*`, tylko okno `background`.
- Folder pracy: wymagany (krok konfiguracji), ścieżka bezwzględna, bez `..`, bez znaków sterujących, ≤ 1024 znaki.
- Nowy kod po angielsku z opisami funkcji (≤ 20 linii × 75 znaków); kod serwera i wtyczki zachowuje istniejące polskie nazewnictwo modułów, które rozszerza.
- `npm test` zielony; wdrożenie na pilota tylko po zgodzie Michała.

## Review Focus
1. Osoba spoza kandydatów pyta o cudze zadanie → 403 `BRAK_DOSTEPU` (test serwera).
2. Zdarzenie wygasło z historii (TTL 90 dni) → `zdarzenie: null`, zadanie nadal zwrócone (test serwera).
3. Folder z `..` lub względny → odrzucony w ustawieniach (test config).
4. Id z `&q=` lub `/` → link nie powstaje (test linku).
5. Brak aplikacji Claude → czytelny komunikat, nie cisza (kod błędu `CLAUDE_NOT_FOUND`).

### Task 1: Serwer `GET /zadania/{id}` + trasa CDK + typ w `wspolne`
- [ ] Testy w `serwer/test/api/api.test.ts` (200 z odchudzonym zdarzeniem, 403, 404, `zdarzenie: null`), `infra/test/stos.test.ts` (trasa istnieje z autoryzatorem).
- [ ] `zdarzenieZadania(firma, zdarzenieId, utworzono)` w `serwer/src/dane/historia.ts`; handler `szczegoly` w `serwer/src/api/zadania.ts`; trasa w `index.ts` i `infra/lib/stos.ts`; `TaskDetailsResponse` w `wspolne/src/api.ts`.
### Task 2: CLI `zadanie` + skill
- [ ] Test w `wtyczka/test/cli.test.mjs`; polecenie w `wtyczka/cli/lib/api.mjs`; sekcja w `skills/cognifly/SKILL.md`.
### Task 3: Aplikacja
- [ ] `src/logic/claude-link.ts` (`claudeLink(id, folder)`), pole `workFolder` w config (+ testy), RPC `task.openInClaude`, przycisk w skrzynce, opener (Rust + capability `opener:allow-open-url` z zakresem `claude://*`).
### Task 4: Weryfikacja
- [ ] Testy; wdrożenie na pilota (po zgodzie); klik „Pracuj w Claude” na prawdziwym zadaniu.
