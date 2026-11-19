# Przepięcie CogniFly test na Platformę: wspólne okno

Instrukcja wspólnego okna z Heartwood. Kroki 3 i 4 wykonuje się jeden po drugim,
bez przerwy. Nic nie jest wdrażane ani scalane bez wyraźnego „tak” Michała.
Miejsca oznaczone **ZAPYTAJ MICHAŁA** to bramki: zatrzymaj się i czekaj na zgodę.

## Co się zmienia

- Logowanie i autoryzator API HTTP używają puli Platformy (klient `cognifly`
  = `130crcifqe1l4uggfap3p7kiml`) zamiast puli CogniFly.
- Rejestr osób CogniFly jest kopią Tożsamości. Zdarzenia obsługuje Lambda
  `TozsamoscZdarzenia` (reguła `cognifly-test-tozsamosc` na hubie
  `platforma-test`). Lambda `TozsamoscUzgodnij` uzgadnia rejestr co godzinę
  (reguła `cognifly-test-uzgodnij`) oraz raz po wdrożeniu, jeśli zmienił się jej
  kod (Trigger CDK). Nieudane zdarzenia trafiają do `cognifly-test-tozsamosc-dlq`.
- Reguła zdarzeń Heartwood przechodzi na hub pod nową nazwą
  `cognifly-test-heartwood-hub`; stara `cognifly-test-heartwood` na
  wewnętrznej szynie znika. Webhook GitHuba zostaje na wewnętrznej szynie `cognifly-test`.
- Osoby dostają nowe `sub`. Rekord `OSOBA#michal` zachowuje zadania, kontakt i
  login GitHub (dopasowanie po e-mailu).
- Aplikacja i wtyczka porzucają zapisaną sesję innego klienta. Trzeba zalogować
  się od nowa.
- Stara pula `eu-central-1_ho5yKP9z4` i jej klient
  `67b7re8ou041svoosk3ukotqrq` zostają w stosie, nieużywane (do wycofania).
- Nowe wyjścia stosu: `Wydawca`, `KlientCognifly`.

## Przed oknem

1. PR scalony do `main` (za zgodą Michała). W korzeniu repo:

```bash
npm ci
```

```bash
npm test
```

2. Michał loguje się do AWS:

```bash
aws login
```

3. Gotowe wartości `-c nadawca=…` i `-c emailAlarmow=…` (jak przy poprzednich
   wdrożeniach). Poniżej `<C>` oznacza cały zestaw:

```
<C> = -c nadawca=… -c emailAlarmow=… -c heartwood='{"intUrl":"https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com","intApiArn":"arn:aws:execute-api:eu-central-1:167702900577:eohqtq0t3j"}'
```

## Kroki okna

### 1. Podgląd zmian CogniFly

```bash
cd infra && npx cdk diff cognifly-test <C>
```

Oczekiwane: nowe Lambdy `TozsamoscZdarzenia` i `TozsamoscUzgodnij`, reguły,
DLQ i Trigger; autoryzator z nowym wydawcą; nowa reguła
`cognifly-test-heartwood-hub` na hubie, stara `cognifly-test-heartwood`
usunięta. **Brak** zastąpienia tabeli, puli i API HTTP. Jeśli
diff pokazuje coś z tych trzech, przerwij.

**ZAPYTAJ MICHAŁA**, czy wdrażać.

### 2. Krok 5 po stronie Heartwood

W repo Heartwood (`~/Documents/Heartwood`), według zadania 11 Heartwood:

```bash
cd infra && npx cdk deploy -a "npx tsx bin/platforma-test.ts" heartwood-test
```

Trigger uzgadniania dodaje firmę `pilot` i nowe `sub` Michała, a stare `sub`
oznacza jako usunięte. Sprawdź log Lambdy `IdentityReconcile` i jej DLQ według
instrukcji Heartwood. Od tej chwili aplikacja ze starą sesją dostaje 401, więc
nie zwlekaj z następnym krokiem.

### 3. Krok 6 po stronie CogniFly, od razu po kroku 2

```bash
cd infra && npx cdk deploy cognifly-test <C>
```

Trigger uzgadnia rejestr na końcu wdrożenia (po API, autoryzatorze i
regułach). Gdy uzgadnianie się nie powiedzie (np. brak uprawnień do `/int/*`),
wdrożenie wycofa się samo. Zobacz „Gdy coś nie działa”.

Sprawdzenia tylko do odczytu. Log uzgadniania powinien pokazać
`orgs ≥ 1, updated ≥ 1`:

```bash
aws logs tail /aws/lambda/cognifly-test-tozsamoscuzgodnij --since 15m --region eu-central-1
```

DLQ ma być pusta (`ApproximateNumberOfMessages` równe 0):

```bash
aws sqs get-queue-attributes --region eu-central-1 --attribute-names ApproximateNumberOfMessages --queue-url "$(aws sqs get-queue-url --queue-name cognifly-test-tozsamosc-dlq --region eu-central-1 --query QueueUrl --output text)"
```

Rekord Michała ma mieć nowy `sub` i brak `usunieta`:

```bash
aws dynamodb get-item --table-name cognifly-test-dane --region eu-central-1 --key '{"pk":{"S":"FIRMA#pilot#KONF"},"sk":{"S":"OSOBA#michal"}}' --projection-expression "sub, usunieta"
```

Jeśli `OSOBA#michal` nie ma nowego `sub`, a uzgadnianie dodało nową osobę
(e-mail w rekordzie inny niż w Tożsamości), naprawa wymaga zgody.
**ZAPYTAJ MICHAŁA** przed każdym z kroków: popraw e-mail w `OSOBA#michal` na
ten z Tożsamości, usuń dodatkowy rekord osoby, a potem uruchom uzgadnianie
jeszcze raz:

```bash
aws lambda invoke --function-name cognifly-test-tozsamoscuzgodnij --region eu-central-1 --payload '{}' --cli-binary-format raw-in-base64-out /dev/stdout
```

### 4. Zasilenie Heartwood

W korzeniu repo CogniFly (po kroku 3 wróć z `infra`: `cd ..`). Na sucho:

```bash
npx tsx infra/skrypty/zasil-heartwood.ts --firma pilot --int-url https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com
```

Sprawdź wypisany plan (przestrzeń, tematy, prawa, ponowne wysłanie pracy
otwartych zadań; osoby bez `sub` są pomijane z ostrzeżeniem). **ZAPYTAJ MICHAŁA.**
Po zgodzie:

```bash
npx tsx infra/skrypty/zasil-heartwood.ts --firma pilot --int-url https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com --wykonaj
```

Między krokiem 2 a tym krokiem prace otwarte bez piszącego (`writer = null`)
mają niedostępne blokady przez kilka minut. To oczekiwane.

### 5. Aplikacja

Zbuduj nową wersję z `main` i zainstaluj ją:

```bash
cd aplikacja && npx tauri build
```

**Uruchom nową aplikację od razu po instalacji.** Dopóki nie ruszy,
`heartwood-token` może jeszcze wypisać token starej puli z Pęku kluczy, a
Heartwood odrzuci go (401). Aplikacja porzuca starą sesję przy pierwszym
starcie.

Michał loguje się kodem z e-maila. Potem sprawdź, że `heartwood-token`
wypisuje token (patrz tylko długość, nie wklejaj go nigdzie), a `heartwood
status` nie zgłasza błędów autoryzacji. Demon Heartwood nadal używa
`token_command` = binarka aplikacji z argumentem `heartwood-token`. Tu nic się
nie zmienia.

### 6. Wtyczka

```bash
node wtyczka/cli/cognifly.mjs konfiguruj --adres-api https://td5k44easl.execute-api.eu-central-1.amazonaws.com --klient 130crcifqe1l4uggfap3p7kiml --region eu-central-1 --firma pilot
```

Potem logowanie (Michał wpisuje kod z e-maila):

```bash
node wtyczka/cli/cognifly.mjs zaloguj --email <e-mail Michała>
```

```bash
node wtyczka/cli/cognifly.mjs kod --kod <kod z e-maila>
```

Sprawdzenie: skrzynka odpowiada bez `BRAK_DOSTEPU` (API rozpoznało nowe `sub`):

```bash
node wtyczka/cli/cognifly.mjs skrzynka
```

### 7. Dalej

Kroki 7–11 zadania 11 Heartwood, według jego instrukcji.

## Gdy coś nie działa

- **Trigger uzgadniania się nie powiódł** (wdrożenie CogniFly wycofało się
  przez Trigger): uzgadnianie nic nie zapisało, stos wrócił do starej puli,
  a stara aplikacja działa dalej. Przeczytaj log Lambdy
  `cognifly-test-tozsamoscuzgodnij`, popraw przyczynę i wdróż ponownie.
  Pojedyncze 403 z `/int/*` tuż po utworzeniu roli to zwykle opóźnienie IAM:
  wystarczy ponowić wdrożenie. Heartwood działa już na Platformie, więc do
  udanego wdrożenia CogniFly zdarzenia Heartwood nie docierają (patrz
  archiwum huba niżej).
- **Wycofanie po udanych zapisach uzgadniania** (wdrożenie wycofało się z
  innego powodu, po Triggerze, albo wycofujesz je ręcznie): rejestr ma już
  nowe `sub`, a stare `sub` straciło wpis w `PROFIL`. Przywróć je według
  „Wycofanie”.
- **401 z Heartwood w aplikacji:** stara sesja. Uruchom nową aplikację i
  zaloguj się od nowa.
- **Zdarzenia Heartwood trafiły na hub, zanim CogniFly tam słuchał:** archiwum
  huba (30 dni) pozwala je odtworzyć.

## Wycofanie

Stara pula jest nadal w stosie. CogniFly:

```bash
git checkout <poprzedni commit main>
```

Ten commit używa jeszcze `@aws-sdk/client-cognito-identity-provider`
(stary skrypt zasiewu), którego ta gałąź już nie ma. Zainstaluj zależności od
nowa, w korzeniu repo:

```bash
npm ci
```

```bash
cd infra && npx cdk deploy cognifly-test <C>
```

Wróć do korzenia repo (dalsze polecenia zakładają korzeń):

```bash
cd ..
```

Potem poprzednia wersja aplikacji i wtyczka na starym kliencie:

```bash
node wtyczka/cli/cognifly.mjs konfiguruj --adres-api https://td5k44easl.execute-api.eu-central-1.amazonaws.com --klient 67b7re8ou041svoosk3ukotqrq --region eu-central-1 --firma pilot
```

Rekord `OSOBA#michal` ma po oknie nowe `sub`, a stare `sub` straciło wpis w
`PROFIL`. Na poprzednim commicie przywraca je stary skrypt zasiewu (szuka
użytkownika w starej puli i zapisuje tożsamość oraz osobę). Najpierw na sucho,
potem **ZAPYTAJ MICHAŁA** i dodaj `--wykonaj`:

```bash
npx tsx infra/skrypty/zasiej-pilot.ts --email-michal <e-mail Michała> --pula eu-central-1_ho5yKP9z4
```

Po wycofaniu nie działa już uzgadnianie (Lambdy nie ma w starym stosie), więc
nic nie nadpisze przywróconego `sub`. Heartwood wycofuje się według własnego
planu.

## Zostaje na później

- Sprawdzanie dostępu `GET /access` w aplikacji i demonie.
- Licencja `lic_cognifly` (zdarzenia `org.*` są dziś pomijane).
- Usunięcie starej puli i jej klienta ze stosu (osobne sprzątanie po udanym
  oknie).
- Zdarzenia między produktami z polem `org`.
- Zdarzenia Tożsamości z firm, które nie używają CogniFly, też tworzą rekordy
  w rejestrze; dostęp odetnie dopiero `lic_cognifly` / `GET /access`.
