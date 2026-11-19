# CogniFly: „Pliki zadania” i przeglądarka Heartwood — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pod zadaniem pełna lista „Pliki zadania” (zablokowane + zmienione) z serwera Heartwood, a w zakładce „Pliki” drzewo przestrzeni ze stanem blokad i akcjami.

**Architecture:** Dane wyłącznie z demona Heartwood (nowe polecenia `work-files`, `files` oraz `space`+`path` w poleceniach serwerowych — plan Heartwood `docs/superpowers/plans/2026-11-19-heartwood-pliki-pracy.md` w repo Heartwood). Logika w TS (`aplikacja/src/logic`), okno główne przez RPC, bez kopii danych w CogniFly. Zapamiętywanie blokad w `localStorage` (D11 adaptera) znika.

**Tech Stack:** TypeScript (vitest), Tauri v2 (Rust, tylko lista dozwolonych poleceń).

**Spec:** Heartwood `docs/superpowers/specs/2026-11-19-heartwood-pliki-pracy-i-przegladarka-design.md` rozdz. 6 (repo `~/Documents/Heartwood`, gałąź `docs/przegladarka-plikow`) i kontrakt rozdz. 9 po zmianach planu Heartwood (Task 1).

**Zależność:** wymaga klienta Heartwood z poleceniami `work-files` i `files` (plan Heartwood, T4–T6). Testy CogniFly używają atrap portu, więc kolejność budowy jest dowolna; próba na żywo — po zainstalowaniu nowego klienta.

## Global Constraints

- Kod po angielsku, komentarz dokumentujący każdej funkcji (≤ 20 linii, ≤ 75 znaków w linii), funkcje atomowe, bez duplikatów; teksty UI po polsku.
- Okno główne bez nowych uprawnień Tauri; wszystko przez RPC do okna tła; DOM tylko przez `textContent`.
- Dane z demona to dane (ścieżki, nazwy osób): nigdy jako HTML ani tekst sterujący.
- Odmowy demona pokazywane przez `hwMessage(code, detail)`; długie wywołania z `DAEMON_WAIT_MS`, okna systemowe z `PICKER_WAIT_MS`.
- Testy: `npm test` (root), `npx tsc --noEmit` i `npm run build` w `aplikacja`, `cargo test` w `aplikacja/src-tauri` zielone.

## Review Focus

1. Zadanie bez blokad i bez zmian (praca nieznana Heartwood) pokazuje pustą listę i — dla piszącego — przycisk „Zablokuj pliki…”, a nie błąd. Test: T1 „empty work is not an error”.
2. Osoba, która nie jest piszącym pracy (`writer !== mój sub`), widzi listę tylko do odczytu, także gdy jest wykonawcą w CogniFly, a Heartwood jeszcze nie przestawił `writer`. Test: T1 „only the writer gets actions”.
3. Plik zapisany 30 razy w zadaniu to jeden wiersz z „30 zapisów”, a nie 30 wierszy. Test: T1 „groups versions per file”.
4. Przeglądarka przy przestrzeni niewybranej nie oferuje „Otwórz w Finderze” ani akcji wymagających ścieżki lokalnej (`restore`). Test: T1 `treeViewModel` „unselected space has no local actions”.
5. Przejście między zadaniami nie pokazuje listy poprzedniego zadania (wyścig odpowiedzi). Test: T2 „stale work-files reply is dropped”.

---

### Task 1: Logika (czyste funkcje i typy)

**Files:**
- Modify: `aplikacja/src/logic/heartwood.ts` (typy, parsery; usuń `lockedPaths`/`rememberLocked`/`forgetLocked`), `aplikacja/src/logic/files-view.ts` (modele widoków)
- Test: `aplikacja/test/heartwood.test.ts`, `aplikacja/test/files-view.test.ts`

**Interfaces:**
- Produces:
  - Typy: `HwWorkFiles { writer: string|null; closed: boolean; locks: HwWorkLock[]; hiddenLocks: number; versions: HwWorkVersion[]; cursor?: string }`, `HwWorkLock = { space; path; folder; by; at; workId; writer: string|null; localPath: string|null }`, `HwWorkVersion = { space; path; seq; author; at; kind; fromPath?; localPath: string|null }`, `HwBrowse { space; folder: string; selected: boolean; entries: HwBrowseEntry[] }`, `HwBrowseEntry { path; localPath: string|null; folder: boolean; size?: number; state: 'free'|'writable'|'locked'|'local_changed'|'conflict'; workId?; writer?; lockFolder?: boolean }`.
  - `parseWorkFiles(v: unknown): HwWorkFiles | null`, `parseBrowse(v: unknown): HwBrowse | null` (odrzucają złe wiersze pojedynczo, jak `parseVersions`).
  - `taskFilesModel(w: HwWorkFiles | null, me: string | null): { canEdit: boolean; locks: LockRow[]; changes: ChangeRow[]; hiddenNote: string | null; closed: boolean }`
    - `canEdit = !!me && w.writer === me && !w.closed` („only the writer gets actions”; `me` = `sub` z sesji — zob. T2).
    - `LockRow { label: string /* "<ws>/<path>" lub "<ws>/<path>/ (folder)" */; who: string; when: string; space; path }`.
    - `ChangeRow { label; latestSeq; count: number; kindText: 'zmiana'|'przywrócenie'|'przeniesienie z <from>'|'usunięcie'; who; when; space; path; versions: HwWorkVersion[] }` — „groups versions per file” (klucz `space`+`path`, najnowsza wersja na wierzchu; `delete` jako najnowsza → `usunięcie`).
    - `hiddenNote`: przy `hiddenLocks > 0` — `"<N> blokad w tematach, do których nie masz dostępu"` (odmiana: 1 → „1 blokada”, 2–4 → „blokady”, inne → „blokad”).
    - „empty work is not an error”: `w` z pustymi listami → `locks: [], changes: []`.
  - `treeViewModel(b: HwBrowse, myTasks: { id: string; workId: string; title: string }[]): { rows: TreeRow[]; canOpenFolder: boolean }`, `TreeRow { name; path; folder; stateText; taskLink: { taskId: string; title: string } | null; actions: ('lock'|'requestRelease'|'history'|'open')[] }`:
    - `stateText`: `free` „wolny”, `writable` „moje zadanie”, `locked` „zablokowany — <writer ?? 'nikt nie pisze'>”, `local_changed` „czeka na wysłanie”, `conflict` „konflikt”.
    - `taskLink` gdy `workId` = `cognifly:<id>` i `id` pasuje do `TASK_ID_PATTERN` (tytuł z `myTasks`, inaczej sam id).
    - akcje: `free` → `lock`, `history`; `locked` → `requestRelease`, `history`; `writable` → `history`; foldery → bez `history`; „unselected space has no local actions”: `canOpenFolder = b.selected`.
- [ ] Testy (Review Focus 1–4 + parsery na śmieciach) → FAIL → implementacja → PASS → **Commit** `feat(aplikacja): modele „Pliki zadania” i przeglądarki`

### Task 2: Kontroler, RPC i lista poleceń w Rust

**Files:**
- Modify: `aplikacja/src/logic/controller.ts`, `aplikacja/src/windows/protocol.ts`, `aplikacja/src-tauri/src/heartwood/socket.rs` (`ALLOWED` + `files`, `work-files`), `aplikacja/src/logic/session.ts` lub miejsce, gdzie da się odczytać `sub` z tokenu dostępu (claim `sub` z JWT, bez weryfikacji podpisu — tylko do porównania z `writer`)
- Test: `aplikacja/test/controller.test.ts`, `cargo test`

**Interfaces:**
- Consumes: T1.
- Produces (metody RPC; `Methods` w `protocol.ts`):
  - `task.files {id}` → `{ files: HwWorkFiles; me: string | null }` (woła `work-files` z `workIdFor(id)`); zastępuje `task.lockedFiles`.
  - `task.lockFiles {id}` — bez zmian w UI, ale bez zapamiętywania; `task.releaseFiles {id, space?, path?}` — z `space`+`path` zwalnia jedną blokadę, bez — wszystkie widoczne z `task.files` (pogrupowane po przestrzeni, `release` z `space`+`paths`).
  - `files.tree {space, folder?}` → `HwBrowse`; `files.lockFor {taskId, space, path}` → `lock` z `space`, `workId` zadania; `files.requestRelease {space, path}`; `files.history {path}` przyjmuje też `{space, path}`; `files.download {path|space+path, version}`.
  - `me`: `sub` z tokenu dostępu bieżącej sesji (funkcja `subOf(accessToken): string | null`, czysta, test).
  - „stale work-files reply is dropped”: UI (T3) porównuje id zadania odpowiedzi; kontroler zwraca `id` w wyniku (`{ id, files, me }`).
  - Rust: `ALLOWED` ma 11 poleceń; `files` i `work-files` z czasem odpowiedzi 30 s (stała `MEDIUM_WAIT`; oba mogą wołać serwer).
- [ ] Testy z atrapą portu: `task.files` woła `{cmd:'work-files', workId:'cognifly:zad_…'}`; `task.releaseFiles` bez ścieżki zwalnia wszystkie widoczne pogrupowane po przestrzeni; `files.lockFor` waliduje id zadania i ścieżkę (`../`) → `BAD_REQUEST` bez wołania; `subOf` na prawdziwym kształcie JWT i na śmieciach; `cargo test` (lista dozwolonych). → **Commit** `feat(aplikacja): RPC plików zadania i przeglądarki`

### Task 3: Widoki

**Files:**
- Modify: `aplikacja/src/windows/screens/task-actions.ts` (sekcja „Pliki zadania”), `aplikacja/src/windows/screens/files.ts` (drzewo nad dotychczasowym stanem przestrzeni), `aplikacja/main.html`, `aplikacja/src/style.css`

**Interfaces:**
- Consumes: T1 modele, T2 RPC.
- Produces (UI, teksty dokładnie):
  - Pod zadaniem (widoczne dla każdego zadania w skrzynce, gdy Heartwood działa): nagłówek „Pliki zadania”; sekcje „Zablokowane” i „Zmienione w zadaniu”; puste: „Brak zablokowanych plików.” / „Brak zmian w tym zadaniu.”; przy `canEdit`: „Zablokuj pliki…”, „Zwolnij wszystkie”, przy wierszu „Zwolnij”; przy zmianie „Pobierz” (ostatnia wersja) i rozwinięcie „<count> zapisów” do listy wersji; `hiddenNote` pod listą; zadanie zamknięte: dopisek „Zadanie zamknięte — blokady zwolnione.”. Odświeżanie: przy rozwinięciu zadania, po akcji i co 15 s, gdy widoczne.
  - Zakładka „Pliki”: wybór przestrzeni (z `status.spaces` + opcja wpisania innej), ścieżka okruszkowa folderu, filtr „Tylko zablokowane”, „Otwórz w Finderze” (gdy `canOpenFolder`; przez istniejący port otwierania — jeśli brak, dodaj RPC `files.reveal {space, folder}` korzystające z `opener` z ograniczeniem do ścieżek pod `root`), wiersze `TreeRow` z akcjami: „Zablokuj do zadania…” (lista moich zadań z `canLockFiles`), „Poproś o zwolnienie”, „Historia”, link do zadania otwiera je w skrzynce (istniejący `focusTask`). Dotychczasowe sekcje (przestrzenie, konflikty, pominięte) zostają pod drzewem.
- [ ] `npm test`, `tsc`, `npm run build` → PASS; **Commit** `feat(aplikacja): „Pliki zadania” pod zadaniem i przeglądarka przestrzeni`

### Task 4: Dokumentacja i próba lokalna

**Files:** `docs/heartwood.md` (zastąp D11 opisem „Pliki zadania”; przeglądarka), `aplikacja/scripts/heartwood-smoke.sh` (opcjonalnie: `work-files` w teście na żywo, jeśli klient ma polecenie).
- [ ] Próba lokalna z nowym klientem (`HEARTWOOD_DIR` na gałęzi planu Heartwood): `live_status_roundtrip` + `work-files` zwraca pustą pracę bez błędu. **Commit** `docs: pliki zadania i przeglądarka Heartwood`
