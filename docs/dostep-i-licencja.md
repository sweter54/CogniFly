# Dostęp i licencja CogniFly

CogniFly pracuje tylko dla osób, które mają dostęp do firmy i licencję `cognifly`
w Platformie (Tożsamość). Nic nie jest wdrażane bez wyraźnego „tak” Michała.
Miejsca oznaczone **ZAPYTAJ MICHAŁA** to bramki: zatrzymaj się i czekaj na zgodę.

## Jak to działa

### API

Platforma w wersji 2 pozwala osobie należeć do kilku firm. Token takiej
osoby (klient współdzielony `cognifly`) nie ma claimów `org` ani
`lic_cognifly`. API sprawdza więc licencję na dwa sposoby.

**Szybka ścieżka (claim).** Token niesie `lic_cognifly`, a nagłówek
`X-Cognifly-Firma` jest pusty albo równy claimowi `org`:

- `lic_cognifly` to znacznik czasu ISO 8601 z przesunięciem: początek dnia
  po końcu licencji.
- Licencja jest ważna, gdy teraz jest przed tym znacznikiem.
- Nieczytelny claim oznacza brak licencji.
- Nazwę claimu można zmienić zmienną `COGNIFLY_LICENCE_CLAIM`.
- Claim jest aktualny najpóźniej po 60 minutach.

**Platforma (brak claimu albo inna firma).** API pyta
`GET <TOZSAMOSC_URL>/access?product=cognifly&org=<firma z nagłówka>` z
tokenem osoby:

- Wynik (zgoda i odmowa) jest w pamięci Lambdy 5 minut. Klucz to skrót
  SHA-256 tokenu i firma; token nie jest przechowywany.
- `GET /ja` (wybór firmy) przechodzi, gdy którakolwiek firma osoby ma dostęp.
  Nieaktualna firma w konfiguracji klienta nie blokuje więc wyboru.
- Platforma chwilowo niedostępna (błąd sieci, przekroczenie 1,5 s, 5xx,
  429): API używa ostatniej odpowiedzi Platformy dla tego tokenu i firmy,
  także przeterminowanej, ale nie starszej niż 60 minut (tyle, co claim w
  tokenie). Dopiero gdy takiej nie ma, żądanie przechodzi (błąd sieci nie
  blokuje pracy).
- Inny status 4xx albo nieczytelna treść oznacza błędną konfigurację (np.
  zły `TOZSAMOSC_URL`): API odpowiada 503 `TOZSAMOSC_NIEDOSTEPNA` i zapisuje
  błąd w logu (alarm błędów Lambdy go nie widzi, sprawdź logi).
- Bez `TOZSAMOSC_URL` albo bez tokenu liczy się tylko claim (jak dotąd).
- Adres to parametr SSM `/platforma/<etap>/tozsamosc/api-url`; infra
  przekazuje go Lambdzie API jako `TOZSAMOSC_URL`.

Odmowa daje 403:

| Przyczyna | Kod API |
|---|---|
| `NO_LICENCE` z Platformy, brak lub nieczytelny claim | `BRAK_LICENCJI` |
| `LICENCE_EXPIRED` z Platformy, przeterminowany claim | `LICENCJA_WYGASLA` |
| inny powód z Platformy | `BRAK_DOSTEPU` z polem `powod` (np. `ORG_SUSPENDED`) |

Błędna odpowiedź Platformy (4xx poza 429, zła treść) daje 503
`TOZSAMOSC_NIEDOSTEPNA`.

### Aplikacja

Aplikacja pyta `GET /access?product=cognifly&org=<firma>` w Tożsamości
(token dostępu). Firma to `company` z konfiguracji aplikacji. Pyta:

- przy starcie i po zalogowaniu,
- co 5 minut (przy wstrzymaniu przy każdym odpytaniu),
- zaraz po odmowie licencji z API,
- po zmianie firmy w ustawieniach.

Wynik jest ważny 5 minut. Gdy Tożsamość odpowie `NOT_MEMBER` dla zapisanej
firmy (albo `GET /ja` jej nie zawiera), aplikacja pobiera `GET /ja`:

- osoba ma dokładnie jedną firmę: aplikacja przechodzi na nią (jak ręczna
  zmiana: czyści zadania i pamięć powiadomień, restartuje pliki), pokazuje
  powiadomienie „Nie należysz już do firmy X — przełączono na firmę Y.”,
  zapisuje zmianę w logu i pyta ponownie;
- osoba ma kilka firm: praca jest wstrzymana bez wylogowania z banerem
  „Nie należysz już do firmy X — wybierz firmę w Ustawieniach.”; wybór
  firmy wznawia pracę;
- `GET /ja` się nie udał albo nadal zawiera firmę: obowiązuje `NOT_MEMBER`
  (wylogowanie).

### Wtyczka

- Przed 12 poleceniami pracy wtyczka sprawdza dostęp:
  `GET /access?product=cognifly&org=<firma>`. Firma to `--firma` polecenia
  albo firma z konfiguracji (`konfiguruj --firma`); bez firmy wtyczka pyta
  bez `org`. Wynik trzyma 5 minut w `~/.cognifly/dostep.json`, osobno dla
  konta i firmy.
- Przy odmowie zwraca stan `BRAK_DOSTEPU_FIRMY`.
- Hook startu sesji Claude pokazuje powód zamiast podsumowania zadań.
- Adres Tożsamości ustawia `konfiguruj --adres-tozsamosci <https>`. Bez niego
  wtyczka niczego nie sprawdza (stara konfiguracja działa jak dotąd).

## Powody i co widzi użytkownik

Każdy komunikat zaczyna się od „Brak dostępu do CogniFly: ”.

| Powód | Tekst | Skutek w aplikacji |
|---|---|---|
| `TOKEN_REVOKED` | sesja wygasła lub została unieważniona — zaloguj się ponownie. | wylogowanie, powód na ekranie logowania |
| `ACCOUNT_DISABLED` | konto jest wyłączone. | wylogowanie, powód na ekranie logowania |
| `NOT_MEMBER` | nie należysz już do firmy. | wylogowanie, powód na ekranie logowania |
| `ORG_SUSPENDED` | firma jest zawieszona. | wstrzymanie pracy |
| `NO_LICENCE` | firma nie ma licencji na CogniFly. | wstrzymanie pracy |
| `LICENCE_EXPIRED` | licencja firmy na CogniFly wygasła. | wstrzymanie pracy |
| `ORG_REQUIRED` | aplikacja: należysz do kilku firm — wybierz firmę w ustawieniach CogniFly. Wtyczka: należysz do kilku firm — wybierz firmę (`--firma`) w konfiguracji wtyczki. | wstrzymanie pracy |
| `MACHINE_REVOKED` | dostęp tego urządzenia został cofnięty. | wstrzymanie pracy |
| inny | odmowa dostępu (`<kod>`). | wstrzymanie pracy |

Wstrzymanie to: baner z powodem, pierwsza pozycja w kolejce „Do załatwienia”
w tacce, odmowa akcji na zadaniach. Kolejne sprawdzenie (co 5 minut albo
„Odśwież”) wznawia pracę, gdy dostęp wróci.

Błąd sieci nigdy nie blokuje pracy. API i tak pilnuje licencji. Przestarzały
claim w tokenie po przywróceniu licencji naprawia jedno odświeżenie tokenu i
ponowienie żądania.

## Wdrożenie

Najpierw PR scalony do `main` (za zgodą Michała). Zestaw `<C>` jak w
`docs/przepiecie-na-platforme.md`. Zmienia się tylko Lambda API: kod i
zmienna `TOZSAMOSC_URL` (z istniejącego parametru SSM
`/platforma/test/tozsamosc/api-url`). Kolejność: API, aplikacja, wtyczka. Każdy
blok poleceń uruchamiaj z katalogu głównego repo (podkatalogi są jawne:
`(cd infra && ...)`).

### 1. API

Przed wdrożeniem sprawdź, czy token pilota niesie claim licencji (drukuje
tylko `lic_cognifly` i `org`, nigdy token):

```bash
python3 - <<'PY'
import base64, json, os
t = json.load(open(os.path.expanduser('~/.cognifly/sesja.json')))['accessToken']
p = t.split('.')[1]
c = json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))
print('lic_cognifly:', c.get('lic_cognifly'))
print('org:', c.get('org'))
PY
```

Oczekiwane dla osoby w jednej firmie: `lic_cognifly` to przyszły znacznik
ISO (pilot: `2028-01-01T00:00:00+01:00`), a `org` to jej firma. Dla osoby w
kilku firmach oba są `None`; ten stan obsługuje kontrola przez Platformę.
Gdy osoba jest w jednej firmie, a claimu brakuje — **zatrzymaj się, nie
wdrażaj**.

Sprawdź też, czy Platforma odpowiada dla firmy (drukuje tylko odpowiedź,
nigdy token):

```bash
python3 - <<'PY'
import json, os, urllib.request
t = json.load(open(os.path.expanduser('~/.cognifly/sesja.json')))['accessToken']
u = 'https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com/access?product=cognifly&org=pilot'
r = urllib.request.Request(u, headers={'Authorization': 'Bearer ' + t})
print(json.load(urllib.request.urlopen(r)))
PY
```

Oczekiwane: `'active': True`. Gdy nie — **zatrzymaj się, nie wdrażaj**.

Podgląd zmian (tylko Lambda API: kod, `TOZSAMOSC_URL` i parametr SSM
szablonu):

```bash
(cd infra && npx cdk diff cognifly-test <C>)
```

**ZAPYTAJ MICHAŁA**, czy wdrażać. Po zgodzie:

```bash
(cd infra && npx cdk deploy cognifly-test <C>)
```

Wycofanie: wdróż poprzedni commit `main` stosu (`git checkout <poprzedni
commit>` i to samo `cdk deploy` co wyżej).

### 2. Aplikacja

**ZAPYTAJ MICHAŁA.** Zbuduj wersję release z `main`:

```bash
(cd aplikacja && npx tauri build --bundles app)
```

Zamknij działającą aplikację, podmień ją i uruchom nową:

```bash
rm -rf /Applications/CogniFly.app
ditto aplikacja/src-tauri/target/release/bundle/macos/CogniFly.app /Applications/CogniFly.app
```

Jeśli API odmówiło z powodu licencji, a Tożsamość jest niedostępna,
aplikacja pozostaje wstrzymana do czasu odpowiedzi Tożsamości.

### 3. Wtyczka

**ZAPYTAJ MICHAŁA.** Claude Code uruchamia zainstalowaną kopię z cache, więc
samo `git pull` nie wystarcza. Po kolei:

```bash
git -C "$HOME/Library/Application Support/CogniFly/repo" pull --ff-only origin main
claude plugin marketplace update cognifly
claude plugin update cognifly@cognifly
```

Zapisz konfigurację z adresem Tożsamości:

```bash
node "$HOME/Library/Application Support/CogniFly/repo/wtyczka/cli/cognifly.mjs" konfiguruj --adres-api https://td5k44easl.execute-api.eu-central-1.amazonaws.com --klient 130crcifqe1l4uggfap3p7kiml --region eu-central-1 --firma pilot --adres-tozsamosci https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com
```

Adres Tożsamości musi zaczynać się od `https://`. `--firma` to firma, o
której dostęp wtyczka pyta i dla której pracuje; osoba w kilku firmach musi
ją podać. Na końcu uruchom nową sesję Claude (albo `/reload-plugins`).
`claude plugin list` powinno pokazać `cognifly` w wersji 0.8.1.

Narzędzia MCP wtyczki nie sprawdzają dostępu z góry; polegają na odmowie API.

## Test na żywo

**ZAPYTAJ MICHAŁA**: test zmienia licencję firmy `pilot`.

1. Ustaw koniec licencji `cognifly` na wczoraj (`<wczoraj>` = data `RRRR-MM-DD`):

```bash
node ~/Documents/Platforma/scripts/operator.mjs https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com PUT /operator/orgs/pilot/licences/cognifly '{"until":"<wczoraj>"}'
```

2. W ciągu 5 minut aplikacja jest wstrzymana z komunikatem „Brak dostępu do
   CogniFly: licencja firmy na CogniFly wygasła.”.
3. Wtyczka zwraca stan `BRAK_DOSTEPU_FIRMY`, a hook startu sesji pokazuje powód.
4. Po odświeżeniu tokenu API odpowiada 403 `LICENCJA_WYGASLA`. Osoba w
   kilku firmach nie ma claimu: API odmawia, gdy wygaśnie zapamiętana zgoda
   Platformy (≤ 5 minut).
5. Przywróć licencję:

```bash
node ~/Documents/Platforma/scripts/operator.mjs https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com PUT /operator/orgs/pilot/licences/cognifly '{"until":"2027-12-31"}'
```

6. Aplikacja wznawia pracę przy najbliższym sprawdzeniu (≤ 5 minut albo
   „Odśwież”).

## Ryzyka

- Token sprzed zmiany licencji: API przepuszcza do 60 minut, a odcina dopiero
  sprawdzenie `/access` w kliencie (≤ 5 minut).
- Tożsamość niedostępna długo: klienci pracują dalej (sieć nie blokuje). Dla
  osób w jednej firmie ochronę daje claim w API. Dla osób w kilku firmach API
  przez 60 minut trzyma się ostatniej odpowiedzi Platformy, potem (albo gdy
  jej nie ma, np. po zimnym starcie Lambdy) przepuszcza żądania bez kontroli
  licencji (członkostwo w firmie API nadal sprawdza w swoim rejestrze).
- Odmowa Platformy zostaje w pamięci Lambdy do 5 minut albo do odświeżenia
  tokenu (klucz to skrót tokenu). Po przywróceniu licencji API może jeszcze
  tyle odmawiać osobom w kilku firmach.
