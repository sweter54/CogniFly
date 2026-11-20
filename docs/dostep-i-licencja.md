# Dostęp i licencja CogniFly

CogniFly pracuje tylko dla osób, które mają dostęp do firmy i licencję `cognifly`
w Platformie (Tożsamość). Nic nie jest wdrażane bez wyraźnego „tak” Michała.
Miejsca oznaczone **ZAPYTAJ MICHAŁA** to bramki: zatrzymaj się i czekaj na zgodę.

## Jak to działa

### API

- Token dostępu niesie claim `lic_cognifly`. To znacznik czasu ISO 8601 z
  przesunięciem: początek dnia po końcu licencji.
- Licencja jest ważna, gdy teraz jest przed tym znacznikiem.
- Brak claimu albo nieczytelny claim oznacza brak licencji.
- API odpowiada 403 z kodem `BRAK_LICENCJI` albo `LICENCJA_WYGASLA`.
- Nazwę claimu można zmienić zmienną `COGNIFLY_LICENCE_CLAIM`.
- API sprawdza tylko claim. Claim jest aktualny najpóźniej po 60 minutach.

### Aplikacja

Aplikacja pyta `GET /access?product=cognifly` w Tożsamości (token dostępu).
Pyta:

- przy starcie i po zalogowaniu,
- co 5 minut (przy wstrzymaniu przy każdym odpytaniu),
- zaraz po odmowie licencji z API.

Wynik jest ważny 5 minut.

### Wtyczka

- Przed 12 poleceniami pracy wtyczka sprawdza dostęp. Wynik trzyma 5 minut w
  `~/.cognifly/dostep.json`.
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
| inny | odmowa dostępu (`<kod>`). | wstrzymanie pracy |

Wstrzymanie to: baner z powodem, pierwsza pozycja w kolejce „Do załatwienia”
w tacce, odmowa akcji na zadaniach. Kolejne sprawdzenie (co 5 minut albo
„Odśwież”) wznawia pracę, gdy dostęp wróci.

Błąd sieci nigdy nie blokuje pracy. API i tak pilnuje licencji. Przestarzały
claim w tokenie po przywróceniu licencji naprawia jedno odświeżenie tokenu i
ponowienie żądania.

## Wdrożenie

Najpierw PR scalony do `main` (za zgodą Michała). Zestaw `<C>` jak w
`docs/przepiecie-na-platforme.md`. Zmienia się tylko kod Lambdy API.

### 1. API

Podgląd zmian (tylko Lambda API):

```bash
cd infra && npx cdk diff cognifly-test <C>
```

**ZAPYTAJ MICHAŁA**, czy wdrażać. Po zgodzie:

```bash
cd infra && npx cdk deploy cognifly-test <C>
```

### 2. Aplikacja

**ZAPYTAJ MICHAŁA.** Zbuduj wersję release z `main`:

```bash
cd aplikacja && npx tauri build --bundles app
```

Podmień aplikację (ścieżkę `<bundle>` wypisze budowanie, zwykle
`aplikacja/src-tauri/target/release/bundle/macos/CogniFly.app`):

```bash
ditto <bundle> /Applications/CogniFly.app
```

Zamknij starą aplikację i uruchom nową.

### 3. Wtyczka

**ZAPYTAJ MICHAŁA.** Pobierz kod:

```bash
git -C "$HOME/Library/Application Support/CogniFly/repo" pull
```

Zapisz konfigurację z adresem Tożsamości:

```bash
node "$HOME/Library/Application Support/CogniFly/repo/wtyczka/cli/cognifly.mjs" konfiguruj --adres-api https://td5k44easl.execute-api.eu-central-1.amazonaws.com --klient 130crcifqe1l4uggfap3p7kiml --region eu-central-1 --firma pilot --adres-tozsamosci https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com
```

Adres Tożsamości musi zaczynać się od `https://`.

## Test na żywo

**ZAPYTAJ MICHAŁA**: test zmienia licencję firmy `pilot`.

1. Ustaw koniec licencji `cognifly` na wczoraj (`<wczoraj>` = data `RRRR-MM-DD`):

```bash
node ~/Documents/Platforma/scripts/operator.mjs https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com PUT /operator/orgs/pilot/licences/cognifly '{"until":"<wczoraj>"}'
```

2. W ciągu 5 minut aplikacja jest wstrzymana z komunikatem „Brak dostępu do
   CogniFly: licencja firmy na CogniFly wygasła.”.
3. Wtyczka zwraca stan `BRAK_DOSTEPU_FIRMY`, a hook startu sesji pokazuje powód.
4. Po odświeżeniu tokenu API odpowiada 403 `LICENCJA_WYGASLA`.
5. Przywróć licencję:

```bash
node ~/Documents/Platforma/scripts/operator.mjs https://wrnzaptvv6.execute-api.eu-central-1.amazonaws.com PUT /operator/orgs/pilot/licences/cognifly '{"until":"2027-12-31"}'
```

6. Aplikacja wznawia pracę przy najbliższym sprawdzeniu (≤ 5 minut albo
   „Odśwież”).

## Ryzyka

- Token sprzed zmiany licencji: API przepuszcza do 60 minut, a odcina dopiero
  sprawdzenie `/access` w kliencie (≤ 5 minut).
- Tożsamość niedostępna długo: klienci pracują dalej (sieć nie blokuje), a
  ochronę daje claim w API.
