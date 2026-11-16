# CogniFly — projekt (wersja 1)

> Data: 2026-11-16. Autor ustaleń: Michał (sweter54). Spisane z rozmowy projektowej.
> Status: **szkic do akceptacji**. Miejsca oznaczone *(propozycja)* to decyzje spisującego,
> do skorygowania; reszta to ustalenia Michała.

## 1. Po co to jest

CogniFly to **osobny produkt**: wtyczka do Claude'a + serwer zdarzeń w AWS do współpracy zespołu
i firm (także nietechnicznych). Serwer zbiera zdarzenia z systemów, z których firma już korzysta
(repozytoria kodu, poczta, serwery AWS, pliki, komunikator zespołu), decyduje, kogo powiadomić i komu
przydzielić pracę, a **AI pracuje tylko wtedy, gdy zdarzenie tego wymaga** — na żądanie klienta,
według skilla opisującego, jak przetworzyć dane.

Dlaczego tak:
- **Nie marnujemy tokenów.** Nasłuch, filtrowanie, powiadomienia i kolejka działają bez AI.
  Dzisiejszy nasłuch `/zespol` (zadanie co minutę w sesji Claude'a) zużywa tokeny przy każdym pustym
  sprawdzeniu — tego CogniFly ma uniknąć.
- **Gotowe powiadomienie zamiast pytania.** Człowiek albo jego agent dostaje sygnał „przyszło X,
  dotyczy Ciebie”, a nie musi pytać.
- **Przewidywalność.** Każde źródło zdarzeń ma skill z procesem „jak najbardziej oskryptowanym”;
  AI ocenia tylko to, czego skrypt nie rozstrzygnie.

## 2. Dla kogo

- **Pierwsi użytkownicy (pilot):** Michał (sweter54@gmail.com) i Szymon — praca nad własnymi
  projektami (kod, serwery AWS, komunikacja przez `/zespol`).
- **Docelowo:** firmy, także nietechniczne (np. „wrzucono raport”, „na stronie przyszło zamówienie”).

## 3. Cele, nie-cele, anty-cele

**Cele wersji 1**
1. Zdarzenia z sześciu źródeł trafiają na wspólną szynę (Amazon EventBridge): GitHub, GitLab,
   `/zespol`, zdarzenia AWS (serwery, alarmy), poczta, pliki (S3).
2. Konfigurowalny **silnik reguł**: kogo powiadomić, komu przydzielić pracę, kiedy eskalować.
3. **Kolejka pracy** z „biorę” (jedna osoba/agent na raz), stanem i kontynuacją po przerwie.
4. **Eskalacja**: zdarzenie niewzięte przez 15 min (konfigurowalne) → e-mail i/lub Discord.
5. **Historia zdarzeń** dostępna komendą: ostatnie 24 h albo przedział od–do.
6. **Pliki przypisane do zadań**: S3 z wersjami, historia, kłódki na czas pracy, flagi
   bezpieczeństwa, kwarantanna i skan przed udostępnieniem.
7. **Powiadomienia bez tokenów**: mod Claude Code (pasek nad polem wpisywania, licznik w pasku stanu,
   toast, panel), ikona przy zegarze i dymki systemowe, e-mail, Discord.
8. **Wtyczka Claude'a**: skille per źródło (oskryptowane), hooki bez AI, komendy, konektor MCP, mod UI.
9. **Konta i instalacja**: logowanie kodem z maila (Cognito); instalator przyjmuje tylko e-mail,
   serwer wysyła jednorazowy link do strony z danymi do wpisania.
10. Skill **code review**: gdy jestem recenzentem, a autor dorzuca commit, skill sprawdza, czy uwagi
    zostały uwzględnione.

**Nie-cele wersji 1**
- Własny system kontroli wersji („własny git”) — kod zostaje w git klienta; GitHub/GitLab to źródła zdarzeń.
- Ciągła, dwukierunkowa synchronizacja folderów (jak Dropbox).
- Integracja z SharePoint/OneDrive/Google Drive (wersja 2).
- Panel dostawcy do zarządzania pulą klientów, licencje wdrożeniowców, plany cenowe (wersja 2;
  struktura danych ma ich nie wykluczać).
- Własna aplikacja desktop z instalatorem i podpisem kodu dla klientów (wersja 2).
- Przetwarzanie AI na serwerze na koszt CogniFly.

**Anty-cele (porażka, nawet jeśli działa)**
- AI uruchamiane cyklicznie „na wszelki wypadek” (spalanie tokenów).
- Powiadomienia wstrzykiwane w rozmowę tak, że rozpraszają bieżącą pracę lub przenoszą obcą treść
  jako polecenia.
- Dwa agenty przetwarzające to samo zdarzenie.
- Plik dostępny dla kogokolwiek przed skanem.
- Dane klientów (np. z maili) wysyłane do modelu bez kontroli.

## 4. Ograniczenia

- **AWS:** konto testowe Michała `167702900577`, region `eu-central-1` (Frankfurt). Infrastruktura jako
  kod (AWS CDK, TypeScript — jak w repo MC) *(propozycja)*.
- **Serwer bez stale działających maszyn** (serverless): API Gateway, Lambda, EventBridge (szyna,
  Scheduler, archiwum), DynamoDB, S3, Cognito, SES, GuardDuty Malware Protection for S3.
- **Claude nie przyjmuje „push”.** Do Claude'a docieramy: hookami przy starcie sesji, modem UI
  (działa w kodzie aplikacji, nie w modelu — zero tokenów), konektorem MCP, a z zewnątrz przez ikonę
  przy zegarze/dymki/e-mail/Discord.
- Mody działają w Claude Code (terminal, zakładka Code aplikacji desktop, VS Code, mobilnie w
  uproszczeniu); użytkownik musi je włączyć; polityka organizacji może je zablokować.
- **SES** na koncie jest w sandboksie (200 maili/dobę, tylko zweryfikowani odbiorcy) — na pilot
  wystarczy przy zweryfikowanych adresach; przed klientami: wyjście z sandboksu + domena nadawcy
  (SPF, DKIM, DMARC).
- `/zespol` to produkt Szymona na jego koncie AWS; nie ma webhooków ani pola na pliki; jego zasady
  zaufania zabraniają agentowi otwierania linków z wiadomości.

## 5. Rozważone podejścia

| Podejście | Za | Przeciw | Decyzja |
|---|---|---|---|
| **A. Serverless na AWS wokół EventBridge** | EventBridge jako kręgosłup (wymóg), brak maszyny do utrzymania, bez ruchu koszt ~0, natywne zdarzenia AWS i S3, Scheduler do eskalacji | więcej usług AWS, trudniejsze testy lokalne | **wybrane** |
| B. Aplikacja na VPS (Lightsail `mc-serwer`), EventBridge tylko jako wejście | najszybszy start, jedna aplikacja | jedna maszyna (awaria = cisza), więcej utrzymania, kolejki i eskalacje do napisania samemu | odrzucone |
| C. Rozbudowa Mission Control | gotowe organizacje, MCP, worker | MC ma inne zadanie; CogniFly ma być osobnym produktem | odrzucone |
| Nasłuch przez cykliczne zadanie w Claude'ie | najprostsze | spala tokeny | odrzucone (anty-cel) |

## 6. Architektura

```
ŹRÓDŁA                       AWS (eu-central-1, serverless)                            UŻYTKOWNIK
GitHub / GitLab webhook ─▶ API GW → Lambda „wejście” (podpis, normalizacja) ─┐
Poczta: Gmail API (push: Pub/Sub watch) / Microsoft Graph → Lambda ─────────┤
Zdarzenia AWS (CloudWatch, EC2, …) — natywnie ───────────────────────────────┤
Pliki: S3 /kwarantanna → GuardDuty → wynik — natywnie ───────────────────────┤
/zespol: zdarzenia z konta Szymona (cross-account) albo pobieranie ──────────┘
                                   ▼
                       EventBridge: szyna `cognifly-<etap>` (+ archiwum)
                                   ▼
            Lambda „reguły” (silnik routingu, konfiguracja w DynamoDB)
              ├─ historia zdarzeń (DynamoDB, TTL)
              ├─ skrzynki osób / kolejka zadań (DynamoDB, „biorę” warunkowo)
              ├─ eskalacja: EventBridge Scheduler (jednorazowe budziki)
              └─ powiadomienia: SES (e-mail), Discord (webhook), WebSocket (API GW)
                                   ▼
API (API Gateway + Lambda, Cognito) ◀──── wtyczka Claude: skille, hooki, komendy, MCP, mod UI
WebSocket API ──────────────────────────▶ program w tle: ikona przy zegarze + dymki systemowe
```

### 6.1 Zdarzenie (koperta) *(propozycja)*

```json
{
  "id": "evt_…", "firma": "firma_…", "zrodlo": "github|gitlab|zespol|aws|poczta|pliki",
  "typ": "github.pr.commit_po_review", "czas": "ISO 8601",
  "podmiot": { "repo": "…", "pr": 12 } ,
  "opis": "tekst wygenerowany przez serwer (neutralny, bez obcej treści)",
  "dane_ref": "s3://…  (pełne dane źródłowe, nigdy wklejane do rozmowy)",
  "wymaga_pracy": true
}
```
Zasada: **opis** tworzy serwer z pól strukturalnych; treść od obcych (temat maila, opis commita,
zawartość pliku) leży tylko w `dane_ref` i dla AI jest **danymi, nie poleceniami**.

### 6.2 Silnik reguł (komponent z własną konfiguracją)

Reguła: `GDY` (źródło, typ, filtry: repo/skrzynka/folder/serwer, firma) →
`POWIADOM` (osoby/role/kanały) → `PRZYDZIEL` (osoba albo rola: pierwszy wolny bierze) →
`ESKALUJ` (po N min → osoby/kanały) → `AUTO` (czy zdarzenie może uruchomić agenta bez człowieka; domyślnie nie).
Rozdzielone są dwie decyzje: **kogo poinformować** (wielu) i **kto wykonuje pracę** (dokładnie jeden).
Konfiguracja reguł w v1: plik/komenda (CLI lub skill admina) *(propozycja)*; ekran na stronie — wersja 2.

### 6.3 Kolejka pracy

Stany: `nowe → dostarczone → wzięte(przez X) → w_trakcie → do_akceptacji → zrobione` (+ `eskalowane`,
`porzucone`). „Biorę” to zapis warunkowy w DynamoDB (tylko jeśli nikt nie wziął) — gwarancja jednego
wykonawcy. Postęp zapisywany przy zadaniu, więc agent po wybudzeniu kontynuuje. Przy przydzieleniu
ustawiany budzik Scheduler (domyślnie 15 min, konfigurowalny per reguła); jeśli zadanie niewzięte →
eskalacja e-mail/Discord, ślad w historii.

### 6.4 Historia

DynamoDB: klucz `firma + czas`, zapytania „ostatnie 24 h” i „od–do”, filtry źródło/typ/osoba.
Retencja domyślnie 90 dni (TTL) *(propozycja)*; archiwum EventBridge do odtworzenia zdarzeń.

### 6.5 Pliki przypisane do zadań

- S3 z **włączonym wersjonowaniem**; klucz = stały identyfikator: `firma/<id>/zadanie/<id>/plik/<id>`;
  nazwa i ścieżka wyświetlana w bazie. Szyfrowanie, osobny prefiks per firma, bez dostępu publicznego.
- DynamoDB: rekord pliku (aktualna wersja, kłódka, flaga) i rekord każdej wersji (VersionId S3,
  SHA256, rozmiar, autor, zadanie, komentarz). Struktura pozwala później dodać migawki całego
  zadania (manifest).
- **Kłódka na czas pracy** (DynamoDB, zapis warunkowy): weź (jeśli brak/wygasła), przedłużaj co ~5 min,
  oddaj wersję tylko z ważną kłódką i aktualną wersją bazową (inaczej nic nie nadpisuje), zwolnij,
  przejęcie siłą tylko admin (audyt). Wygasanie domyślnie 30 min z automatycznym przedłużaniem
  *(propozycja)*; zasięg: pojedynczy plik *(propozycja)*.
- Zdarzenia: „kłódka wzięta/zwolniona/wygasła”, „plik dodany/nowa wersja”.
- Usunięcie = wersja ze znacznikiem (do przywrócenia) + ścieżka **twardego usunięcia** wszystkich
  wersji (RODO). Reguły cyklu życia S3 dla starych wersji.

### 6.6 Bezpieczeństwo plików (wymaganie v1)

Przepływ: wysyłka linkiem czasowym → `/kwarantanna` (niedostępne) → skan (GuardDuty Malware
Protection for S3; alternatywa ClamAV w Lambdzie) + walidacja typu po zawartości → flaga.

| Flaga | Znaczenie | Dostęp |
|---|---|---|
| `skanowanie` | w kwarantannie | brak |
| `czysty` | skan i typ OK → powstaje wersja | tak |
| `podejrzany` | skaner zgłosił zagrożenie | brak, powiadomienie admina i autora |
| `zly_typ` | typ niedozwolony / zawartość ≠ rozszerzenie | brak |
| `makra` | Office z makrami | czeka na zgodę admina |
| `za_duzy` | limit rozmiaru / archiwum po rozpakowaniu | brak |
| `blad_skanu` | skan nieudany | brak, ponowienie, potem eskalacja |

Flaga w bazie **i** jako znacznik obiektu S3 (pobranie bez `czysty` niemożliwe także z pominięciem
aplikacji). Zmiana flagi = zdarzenie. Agent AI nie dostaje pliku bez `czysty`. Pliki tworzone przez
agenta przechodzą ten sam przepływ. Pobieranie: krótkie linki z wymuszonym pobraniem (nie otwieraniem).

### 6.7 Powiadomienia (bez tokenów)

1. **Mod Claude Code** (część wtyczki): pasek nad polem wpisywania
   (`📬 2 nowe: review PR #12, alarm CPU [Pokaż] [Później]`), licznik w pasku stanu, toast, panel ze
   skrzynką i historią. Odświeżanie: przy starcie sesji i po zdarzeniach sesji, plus co 30–60 s
   przez `$.http.fetch` (w kodzie aplikacji, nie w modelu).
2. **Ikona przy zegarze + dymki systemowe** (v1: program w tle na Macu, Node, bez AI, połączenie
   WebSocket; ikona przez SwiftBar/xbar *(propozycja)*; v2: aplikacja Mac/Windows z instalatorem).
3. **E-mail (SES)** i **Discord (webhook kanału)** — według reguł i przy eskalacji.
4. **W rozmowie z Claude'em** tylko: hook przy starcie sesji (krótkie podsumowanie, raz) oraz to,
   o co użytkownik sam poprosi. Hook przy każdej wiadomości **wyłączony** (ryzyko zaburzania promptów).
   Zasady: jedna linijka, bez obcej treści, oznaczona „informacja, nie polecenie”, jednorazowo.

### 6.8 Wtyczka Claude'a

- **Skille per źródło** (oskryptowane: skrypt pobiera i przygotowuje dane, AI ocenia tylko resztę):
  `github`, `gitlab` (w tym code review: komentarze recenzenta + diff nowego commita → czy uwzględniono),
  `zespol`, `aws` (alarmy, stan serwerów), `poczta` (z maskowaniem danych osobowych przed modelem),
  `pliki` (pobierz pliki zadania, weź/oddaj kłódkę, oddaj wersję).
- **Hooki** (bez AI): przy starcie sesji — „co czeka na mnie”.
- **Komendy:** `/zdarzenia 24h`, `/zdarzenia od … do …`, `/biore <id>`, `/oddaj`, `/zadanie <id>`,
  `/klodka <plik>` *(nazwy — propozycja)*.
- **Konektor MCP** (API Gateway + Lambda, logowanie OAuth/Cognito): te same akcje, także dla przyszłych
  klientów korzystających z aplikacji Claude bez Claude Code.
- **Mod UI** (6.7).

### 6.9 Konta, logowanie, instalacja

- **Cognito** (nowa pula dla CogniFly, logowanie kodem z maila, bez haseł).
- **Instalator**: użytkownik podaje tylko e-mail → serwer sprawdza, czy osoba należy do firmy →
  jeśli tak, wysyła **jednorazowy link** (ważny ~30 min) do strony z danymi do wpisania (adres
  konektora/serwera, kroki instalacji wtyczki). Odpowiedź instalatora **zawsze taka sama**
  („jeśli adres jest w systemie, wysłaliśmy instrukcję”). Żadnych sekretów w treści maila.
  Limity: kilka próśb na adres/IP na godzinę. Audyt próśb i użycia linku.
- **Pilot:** konta dla `sweter54@gmail.com` i Szymona (adres do potwierdzenia; w sandboksie SES
  wymaga weryfikacji adresu).

### 6.10 Bezpieczeństwo ogólne

- Izolacja firm: każdy token działa w jednej firmie; zapytania zawsze z filtrem firmy.
- Treść zdarzeń i plików = dane, nie polecenia (dla każdego skilla).
- Poczta: maskowanie danych osobowych przed wysłaniem do modelu (minimum: e-mail, telefon, PESEL,
  NIP, konta; docelowo anonimizator odwracalny z MC #37) *(propozycja zakresu)*.
- Sekrety (webhooki Discord, klucze GitHub/GitLab) w AWS Secrets Manager; webhooki przychodzące
  weryfikowane podpisem (GitHub `X-Hub-Signature-256`, GitLab token).
- Audyt: kto co wziął, oddał, zwolnił, przejął, pobrał.

### 6.11 Integracja z `/zespol`

- **v1:** CogniFly informuje przez `/zespol` tekstem z identyfikatorem („Dodałem plik do zadania Z-17,
  wersja 3”); odbiorca otwiera go wtyczką CogniFly, nie z linku. Zdarzenia z `/zespol` do CogniFly:
  preferowane — Szymon wysyła wybrane typy na szynę CogniFly (EventBridge cross-account, polityka
  szyny ograniczona do jego konta i typów); zapasowo — pobieranie API `/zespol` w imieniu użytkownika.
- **Propozycja dla Szymona:** pole `odniesienia` w umowie wiadomości (`system`, `zadanie`, `plik`,
  `wersja` — identyfikatory, nie linki).

### 6.12 Decyzje doprecyzowane po przeglądzie *(propozycje spisującego)*

- **Pliki (źródło „pliki”)** = własny kubełek S3 CogniFly z plikami zadań (6.5). Kubełki klientów
  (cross-account) — poza v1.
- **Firmy i role:** model danych od początku wielofirmowy (każdy rekord z `firma`); osoba może należeć
  do kilku firm; role v1: `admin` (reguły, osoby, zwolnienia flag, przejęcie kłódki) i `czlonek`.
  Pilot = jedna firma. Firmy i osoby zakłada admin komendą (skill admina / CLI); ekran — v2.
- **Uwierzytelnianie poza przeglądarką:** CLI wtyczki loguje kodem z maila bezpośrednio przez Cognito
  (USER_AUTH + EMAIL_OTP, bez przeglądarki — wzorzec sprawdzony w `/zespol`); tokeny w `~/.cognifly/`
  (pliki tylko dla właściciela), ciche odświeżanie. Hooki, mod (`$.fs` + `$.http.fetch`) i program przy
  zegarze używają tej samej sesji. Strona z jednorazowego linku pokazuje tylko adres serwera i kroki
  instalacji wtyczki — **bez kluczy urządzenia**.
- **Klient Claude'a w v1:** pilot pracuje w Claude Code → mod UI jest głównym kanałem w Claude'ie;
  konektor MCP w v1 z logowaniem tokenem z CLI. Dla aplikacji Claude bez Claude Code (osoby
  nietechniczne) w v2 potrzebny będzie serwer autoryzacji z dynamiczną rejestracją klienta (Cognito jej
  natywnie nie ma) — świadomie przesunięte.
- **Zdarzenia AWS w v1:** tylko konto testowe `167702900577`: alarmy CloudWatch, zdarzenia stanu EC2,
  AWS Health, rozliczenia (Budgets). Lightsail nie emituje zdarzeń do EventBridge — dla `mc-serwer`
  lekka Lambda sprawdzająca dostępność co 5 min (EventBridge Scheduler) i emitująca zdarzenie przy
  zmianie stanu. Konta klientów (cross-account) — v2.
- **GitHub / GitLab w v1:** webhooki na wybranych repozytoriach z sekretem (GitHub App — v2);
  gitlab.com (self-hosted — v2). Tożsamość: osoba w CogniFly łączy swój login GitHub/GitLab
  (komenda + potwierdzenie przez OAuth GitHuba/GitLaba lub ręcznie przez admina w pilocie); routing
  i „jestem recenzentem” korzystają z tego powiązania.

### 6.13 Decyzje Michała po przeglądzie

1. **Uruchamianie agenta.** Pracę AI zawsze zaczyna sesja Claude'a uruchomiona przez człowieka.
   Kto chce przetwarzania automatycznego, **zostawia otwartą sesję i włącza w niej tryb auto**
   (przełącznik we wtyczce, np. `/auto on`). W trybie auto mod wykrywa przydzielone tej osobie
   zdarzenia oznaczone regułą `AUTO`, bierze je („biorę”) i uruchamia właściwy skill w tej sesji;
   wynik idzie do akceptacji. Bez otwartej sesji z trybem auto nic nie rusza samo — działa
   eskalacja (15 min → e-mail/Discord). Program w tle (ikona przy zegarze) w v1 tylko powiadamia,
   nie uruchamia Claude'a.
   *Do zweryfikowania przy budowie:* czy mod może sam rozpocząć turę w sesji; zapasowo — hook lub
   komenda, którą mod podsuwa jednym kliknięciem. Limity trybu auto *(propozycja)*: maks. liczba
   zdarzeń na godzinę, limit czasu na zdarzenie, tylko skille oznaczone jako dozwolone w auto.
2. **Poczta przez API skrzynki** (nie SES). v1: **Gmail API** z powiadomieniami push (Pub/Sub
   `watch` → endpoint CogniFly → EventBridge), bez cyklicznego odpytywania. Logowanie OAuth do
   skrzynki z minimalnym zakresem (odczyt), token w Secrets Manager per osoba. Aplikacja Google w
   trybie testowym na pilot (do 100 użytkowników testowych bez weryfikacji); przed klientami —
   weryfikacja aplikacji u Google (zakresy „restricted”, ocena bezpieczeństwa) i umowa powierzenia
   danych. Microsoft 365 (Graph, subskrypcje zmian) — v2. Maskowanie danych osobowych przed modelem
   obowiązuje (6.10).
3. **`/zespol`:** v1 ma **gotowy, nieaktywny punkt odbioru** zdarzeń `/zespol` (reguła szyny i
   polityka dla konta Szymona, wyłączone) do czasu, aż Szymon zrealizuje prośbę o wysyłanie
   zdarzeń. Do tego czasu kierunek CogniFly → `/zespol` działa przez skill `/zespol` zainstalowany u
   użytkownika (wiadomość tekstowa z identyfikatorem). Kryterium sukcesu nr 1 liczy 5 aktywnych źródeł
   + `/zespol` po aktywacji.

## 7. Środowisko testowe

- Konto AWS `167702900577`, `eu-central-1`; etap `test`; tagi `Project=cognifly`.
- Repozytorium: GitHub `sweter54/CogniFly` (prywatne) *(propozycja widoczności)*.
- Istniejące zasoby z poprzedniej pracy (VPS `mc-serwer`, pula Cognito `mc-vps-test`, SES z
  zweryfikowanym `sweter54@gmail.com`) nie są częścią CogniFly; CogniFly ma własne zasoby.

## 8. Kryteria sukcesu pilota *(propozycja — do potwierdzenia)*

1. Zdarzenie z każdego z 6 źródeł pojawia się w historii i w modzie w < 60 s.
2. Zero tokenów zużytych na nasłuch (tokeny tylko przy pracy nad zdarzeniem).
3. Code review: skill poprawnie ocenia uwzględnienie uwag w ≥ 8 z 10 przypadków testowych.
4. Eskalacja po 15 min działa w 100% testów; żadne zdarzenie nie zostaje przetworzone dwa razy.
5. Osoba nietechniczna instaluje wtyczkę z maila bez pomocy w < 10 min.

## 9. Otwarte decyzje (do rozstrzygnięcia)

- Adres e-mail Szymona do konta pilotażowego.
- Termin realizacji prośby do Szymona (zdarzenia `/zespol` na szynę CogniFly); do tego czasu punkt
  odbioru nieaktywny (6.13).
- Model cenowy (wpływa na to, co liczyć: zdarzenia, przetworzenia AI, użytkownicy).
- Zakres maskowania danych w poczcie w v1 (minimum w 6.10).

## 10. Zostawione budowniczemu

Struktura repozytorium (monorepo: `infra/`, `serwer/`, `wtyczka/`, `tray/`), biblioteki, schemat
kluczy DynamoDB, format webhooków wewnętrznych, nazwy komend i typów zdarzeń, testy (jednostkowe +
testy integracyjne na koncie testowym), kolejność wdrażania źródeł.
