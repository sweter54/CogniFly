# CogniFly: nieśledzone, „Przenieś do zadania…”, konflikty i connector zadań (etap 1) — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Aplikacja pokazuje nieśledzone pliki i dołącza je do wybranego zadania, konflikty są pogrupowane; Claude dostaje connector zadań (MCP) z plikami i blokadami zadań z Heartwood.

**Architecture:** Serwer: nowa trasa `GET /zadania/{id}/pliki` (dane z Heartwood `/int`, bez kopii); infra: uprawnienie `execute-api:Invoke` dla `Api`; skrypt zasilania: temat `Zadania`. Aplikacja: logika + widoki nad poleceniami demona `adopt`/`resolve` i polami `untracked`/`conflicts[].copies`. Wtyczka: serwer MCP `cognifly-zadania` (stdio, Node).

**Tech Stack:** TypeScript (vitest), Node MCP SDK `@modelcontextprotocol/sdk`, CDK.

**Spec:** repo Heartwood `docs/superpowers/specs/2026-11-19-heartwood-niesledzone-konflikty-skill-design.md` (rozdz. 2a, 5.1, 5.2, 5.3a); kontrakt lokalnego API po planie Heartwood `docs/superpowers/plans/2026-11-19-heartwood-niesledzone-etap1.md`.

## Global Constraints

- Kod po angielsku, komentarz dokumentujący każdej funkcji (≤ 20 linii, ≤ 75 znaków w linii); teksty UI i narzędzi MCP po polsku.
- Okno główne bez nowych uprawnień; DOM przez `textContent`; dane z demona i z serwera to dane.
- Folder zadania: `<opis skrócony do 60 znaków, oczyszczony> (zad_…)`; istniejący rozpoznawany po końcówce `(zad_…)` w liście `files` tematu `Zadania`.
- Bez wdrożenia na AWS bez zgody Michała.
- Testy: root `npm test`, `npx tsc --noEmit` i `npm run build` w `aplikacja`, `cargo test` gdy zmienia się Rust.

## Review Focus

1. „Przenieś do zadania…” nigdy nie wybiera zadania sam — zawsze lista i wybór. Test: T2 „adopt requires an explicit task”.
2. `GET /zadania/{id}/pliki` nie ujawnia cudzych przestrzeni prywatnych (`user:<inny sub>`) ani zadań, do których osoba nie ma dostępu (403). Test: T1.
3. Connector MCP bez sesji (`~/.cognifly` pusty) odpowiada czytelnym błędem, nie wysypuje się. Test: T4.
4. Nazwa folderu zadania z opisu zawierającego `/`, `:`, emoji, 300 znaków → poprawny segment ≤ 60 znaków + ` (zad_…)`. Test: T2.

---

### Task 1: Serwer i infra — `GET /zadania/{id}/pliki`, temat `Zadania`

**Files:** `serwer/src/api/zadania.ts` (lub nowy `serwer/src/api/pliki.ts`), `serwer/src/api/index.ts`, `serwer/src/heartwood/klient.ts` (`getWorkFiles(org, workId)`), `infra/lib/stos.ts` (trasa w API Gateway jeśli trasy są jawne; `Api` dostaje `HEARTWOOD_INT_URL` i `execute-api:Invoke` na `<intApiArn>/*/*/int/*` tylko z kontekstem `heartwood`), `infra/skrypty/zasil-heartwood.ts` (temat `Zadania` zawsze obok tematów z `--tematy`), testy obok istniejących.

**Interfaces:**
- `IntClient.getWorkFiles(org, workId): Promise<WorkFilesResponse>` (GET `/int/orgs/{org}/work/{workId}/files`, kształt jak w kontrakcie Heartwood 3.5; strony wersji łączone do 20 stron).
- `GET /zadania/{id}/pliki` (dostęp jak `GET /zadania/{id}`: kandydat, właściciel, akceptujący; inaczej 403 `BRAK_DOSTEPU`; nieznane 404) → `{ zadanie: id, pisze: osobaId | null, zamkniete, blokady: [{ przestrzen, sciezka, folder, kto (osobaId|null), kiedy }], zmiany: [{ przestrzen, sciezka, seq, rodzaj, autor (osobaId|null), kiedy }] }`; wpisy z `user:<sub>` innych osób pominięte; `sub` → osobaId przez `tozsamosc`. Bez kontekstu `heartwood` (brak `HEARTWOOD_INT_URL`) → 503 `PLIKI_WYLACZONE`.
- [ ] Testy (atrapa `IntClient`): mapowanie sub→osobaId, ukrywanie cudzych `user:`, 403/404/503, łączenie stron; `stos.test.ts`: `Api` ma `execute-api:Invoke` tylko z kontekstem; `zasil-heartwood.test.ts`: krok tematu `Zadania`. → **Commit** `feat(serwer): pliki zadania z Heartwood i temat Zadania`

### Task 2: Logika aplikacji — nieśledzone, adopt, konflikty

**Files:** `aplikacja/src/logic/heartwood.ts` (parsery `untracked`, `conflicts[].count/copies`, `taskFolderName(task)`), `aplikacja/src/logic/files-view.ts` (sekcja nieśledzonych, wiersz konfliktu), `aplikacja/src/logic/controller.ts` (RPC `files.adopt {paths[], taskId}`, `files.resolve {copyPath}`, `files.revealCopy {copyPath}`), `aplikacja/src/windows/protocol.ts`, `aplikacja/src-tauri/src/heartwood/socket.rs` (`ALLOWED` + `adopt`, `resolve`), testy.

**Interfaces:**
- `taskFolderName(task: Task): string` — opis → usunięte `/\:*?"<>|` i znaki sterujące, spacje zwinięte, przycięte do 60 punktów kodowych bez spacji na końcu, + ` (` + id + `)`; pusty opis → samo `(zad_…)`.
- `files.adopt {paths, taskId}`: ścieżki pod `root` (isUnderRoot), zadanie z `canLockFiles`; najpierw `files {space, folder: 'Zadania'}` → jeśli jest folder kończący się ` (<taskId>)`, użyj jego nazwy, inaczej `taskFolderName`; potem `adopt {paths, workId, taskFolder}`. Paczki po 98 nie dotyczą (jeden folder lock).
- `files.resolve {copyPath}` → `resolve`; `files.revealCopy` → `revealFolder` (tylko ścieżki kopii pod `root`).
- Model: `untrackedRows(status)` → `{ path, label, reasonText, space }`; `conflictRows(status)` → jeden wiersz na plik z `count` („1 kopia”/„2 kopie”/„5 kopii”).
- [ ] Testy: Review Focus 1 i 4, parsery, mapowanie istniejącego folderu, odmowy demona przez `hwMessage`. → **Commit** `feat(aplikacja): nieśledzone pliki, przenoszenie do zadania i pogrupowane konflikty`

### Task 3: Widoki

**Files:** `aplikacja/src/windows/screens/files.ts` (sekcje), `aplikacja/main.html`, `aplikacja/src/style.css`, `aplikacja/src/windows/screens/files-tree.ts` (stan `untracked` → „nieśledzony”).
- Sekcja „Nieśledzone” nad „Konflikty”: wiersz: ścieżka, powód, „Przenieś do zadania…” (lista zadań; brak: „Nie masz zadania, do którego można dołączyć plik.”; po sukcesie: „Przeniesiono do zadania.”).
- „Konflikty”: wiersz na plik: ścieżka, „N kopii”, „Pokaż kopie”, „Oznacz jako rozwiązane” (potwierdzenie „Usunąć kopie konfliktu? Upewnij się, że przepisałeś zmiany.”; usuwa wszystkie kopie pliku).
- [ ] `npm test`, `tsc`, `npm run build` → **Commit** `feat(aplikacja): sekcje Nieśledzone i Konflikty`

### Task 4: Connector zadań — MCP `cognifly-zadania`

**Files:** Create `wtyczka/mcp/zadania.mjs` (serwer), `wtyczka/.mcp.json` (rejestracja: `node ${CLAUDE_PLUGIN_ROOT}/mcp/zadania.mjs`), `wtyczka/test/mcp-zadania.test.mjs`; Modify `wtyczka/package.json` (zależność `@modelcontextprotocol/sdk`), `wtyczka/.claude-plugin/plugin.json` (wersja 0.7.0), `wtyczka/cli/lib/api.mjs` (jeśli potrzebna funkcja `plikiZadania`).

**Interfaces (narzędzia, opisy po polsku, tylko odczyt):**
- `moje_zadania {}` → zadania ze skrzynki: `id, opis, stan, wlasciciel, akceptujacy, moge_blokowac`.
- `pliki_zadania {zadanie}` → wynik `GET /zadania/{id}/pliki`.
- `zadania_dla_pliku {przestrzen, sciezka}` → `{ blokujace: [zadanie…], zmieniajace: [zadanie…], moge_dolaczyc: [zadanie…] }` (z `pliki_zadania` dla moich zadań; limit 30 zadań).
- `blokada_pliku {przestrzen, sciezka}` → `{ stan: 'wolny'|'zablokowany', zadanie?, pisze? }` (z `pliki_zadania` moich zadań; poza moimi zadaniami: `nieznane`).
- Sesja: jak CLI (`~/.cognifly`, odświeżanie tokenu z `sesja.mjs`); brak sesji → wynik narzędzia z `isError` i tekstem „Zaloguj się: cognifly zaloguj”.
- [ ] Testy (atrapa API, wywołania handlerów narzędzi bez transportu): każde narzędzie, brak sesji, walidacja argumentów (`zadanie` zgodne z `TASK_ID_PATTERN`). → **Commit** `feat(wtyczka): connector zadań cognifly-zadania (MCP)`

### Task 5: Dokumentacja

**Files:** `docs/heartwood.md` (nieśledzone, adopt, folder zadania, konflikty, connector zadań; etap 2 jako plan), `wtyczka/skills/cognifly/SKILL.md` (krótka sekcja: kiedy używać narzędzi `cognifly-zadania`).
- [ ] **Commit** `docs: nieśledzone pliki, folder zadania i connector zadań`
