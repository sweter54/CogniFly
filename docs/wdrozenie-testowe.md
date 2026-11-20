# Wdrożenie testowe CogniFly (konto 167702900577, eu-central-1)

Etap `test`, zasoby z prefiksem `cognifly-test-`. Wszystkie polecenia uruchamiaj z profilem AWS wskazującym na konto testowe.

## 1. Lista kontrolna przed pierwszym wdrożeniem

1. **Tożsamość SES nadawcy** jest zweryfikowana w regionie `eu-central-1` (adres podany jako `-c nadawca=...` albo, gdy używasz domeny, cała domena). Powiadomienia wysyłają pocztę z tego adresu. Kody logowania wysyła pula Platformy (Tożsamość), nie CogniFly.
   - Gdy nadawcą ma być adres w zweryfikowanej domenie, dodaj `-c domenaSes=twoja-domena.pl`. Polityka IAM `ses:SendEmail` (zasób `identity/*` + warunek `ses:FromAddress` równy adresowi nadawcy) obejmuje zarówno tożsamość-adres, jak i tożsamość-domenę.
2. **Sandbox SES.** Nowe konto jest w trybie sandbox: SES wysyła tylko do zweryfikowanych adresów. Zweryfikuj w `eu-central-1` także adresy odbiorców testowych (kody logowania i eskalacje) albo poproś o wyjście z sandboxa.
3. **Bootstrap CDK** (jednorazowo, jeśli konto/region jeszcze go nie miały):
   ```
   npx cdk bootstrap aws://167702900577/eu-central-1
   ```
4. Zainstalowane zależności (`npm ci` w korzeniu repo) i przechodzące testy (`npm test`).

## 2. Wdrożenie

```
cd infra
npx cdk deploy -c nadawca=nadawca@twoja-domena.pl -c emailAlarmow=alarmy@twoja-domena.pl
# opcjonalnie: -c domenaSes=twoja-domena.pl
```

Po wdrożeniu zapisz wartości wyjść stosu (`AdresApi`, `AdresWebhookGithub`, `KlientCognifly`, `Wydawca`, `Region`, ...). Wyświetlisz je ponownie:

```
aws cloudformation describe-stacks --stack-name cognifly-test --region eu-central-1 --query "Stacks[0].Outputs" --output table
```

### Potwierdź subskrypcję alarmów

SNS wysyła na adres z `emailAlarmow` wiadomość „AWS Notification - Subscription Confirmation”. Kliknij w niej **Confirm subscription**. Bez tego alarmy (błędy Lambd, DLQ) nie dotrą.

## 3. Sprzątanie po nieudanym pierwszym wdrożeniu

Tabela DynamoDB i pula użytkowników mają politykę RETAIN: po nieudanym (wycofanym) wdrożeniu mogą zostać i zablokować ponowne wdrożenie (nazwa tabeli `cognifly-test-dane` jest zajęta). Usuń je ręcznie, **dopiero po sprawdzeniu, że są puste/niepotrzebne**.

Tabela:
```
aws dynamodb scan --table-name cognifly-test-dane --select COUNT --region eu-central-1
aws dynamodb delete-table --table-name cognifly-test-dane --region eu-central-1
```

Osierocone pule użytkowników (nazwa `cognifly-test-uzytkownicy`). Logowanie działa teraz przez pulę Platformy, a stara pula `eu-central-1_ho5yKP9z4` zostaje w stosie nieużywana (do wycofania, patrz `docs/przepiecie-na-platforme.md`). Nie usuwaj jej przed osobnym sprzątaniem po udanym oknie:
```
aws cognito-idp list-user-pools --max-results 60 --region eu-central-1 \
  --query "UserPools[?Name=='cognifly-test-uzytkownicy'].[Id,Name]" --output text
aws cognito-idp list-users --user-pool-id <ID_PULI> --region eu-central-1
aws cognito-idp delete-user-pool --user-pool-id <ID_PULI> --region eu-central-1
```
(Jeśli pula ma włączoną ochronę przed usunięciem, najpierw `aws cognito-idp update-user-pool --user-pool-id <ID_PULI> --deletion-protection INACTIVE ...`.)

Jeśli stos został w stanie `ROLLBACK_COMPLETE`, usuń go przed ponowną próbą:
```
aws cloudformation delete-stack --stack-name cognifly-test --region eu-central-1
```

## 4. Webhook GitHuba

1. Utwórz sekret podpisu `cognifly-test/github/pilot` w Secrets Manager (losowy ciąg; nazwa kończy się identyfikatorem firmy, tu `pilot`). Robi to zasiew pilota (sekcja 6; losowe 32 bajty hex, jeśli nie podasz własnego), więc najprościej wykonać zasiew przed konfiguracją webhooka.
2. W repozytorium GitHuba: **Settings > Webhooks > Add webhook**.
   - **Payload URL**: wartość wyjścia `AdresWebhookGithub` z `{firma}` zamienionym na `pilot`, np. `https://<id>.execute-api.eu-central-1.amazonaws.com/webhook/github/pilot`.
   - **Content type**: `application/json`.
   - **Secret**: wartość sekretu odczytana poleceniem:
     ```
     aws secretsmanager get-secret-value --secret-id cognifly-test/github/pilot --region eu-central-1 --query SecretString --output text
     ```
     **Uwaga:** wklej go wyłącznie w to jedno pole GitHuba. Nie wklejaj go do czatu, notatek, zgłoszeń ani historii powłoki (np. przez `history -c` po użyciu).
   - Zdarzenia: **Pushes**, **Pull requests**, **Pull request reviews**.
3. W **Recent Deliveries** pierwsze dostarczenie (ping) powinno zwrócić 202 lub 2xx. 401 = zły sekret lub brak sekretu `cognifly-test/github/pilot`; 500 = problem z dostępem do Secrets Manager (zobacz logi Lambdy `cognifly-test-webhook`).

## 5. Konfiguracja wtyczki z wyjść stosu

Logowanie idzie przez pulę Platformy. Wtyczka potrzebuje czterech wartości (plus opcjonalnie adres Tożsamości). Wpisz je jednym poleceniem (zapisze `~/.cognifly/konfiguracja.json`, bez sekretów):

```
node wtyczka/cli/cognifly.mjs konfiguruj \
  --adres-api <AdresApi> --klient <KlientCognifly> --region <Region> --firma pilot \
  --adres-tozsamosci <https://adres-tozsamosci>
```

Mapowanie: `AdresApi` -> `--adres-api`, `KlientCognifly` -> `--klient`, `Region` -> `--region` (domyślnie `eu-central-1`), firma -> `--firma`. `--adres-tozsamosci` jest opcjonalne (adres musi być `https://`). Z nim wtyczka sprawdza dostęp i licencję firmy przed pracą; bez niego niczego nie sprawdza (patrz `docs/dostep-i-licencja.md`). Alternatywnie zmienne środowiskowe `COGNIFLY_ADRES_API`, `COGNIFLY_KLIENT`, `COGNIFLY_REGION`, `COGNIFLY_FIRMA`.

Wtyczka odrzuca zapisaną sesję innego klienta, więc po zmianie `--klient` zaloguj się od nowa kodem z maila (`zaloguj --email ...`, `kod --kod ...`). Osoby nie tworzysz w żadnej puli: konto zakłada Tożsamość, a rejestr osób CogniFly jest jej kopią.

## 6. Zasiew danych pilota

Skrypt `infra/skrypty/zasiej-pilot.ts` (`npm run zasiej -w @cognifly/infra -- ...`) zapisuje sekret GitHuba i kontakty. Nie tworzy użytkowników: osoby pochodzą z Tożsamości (Lambda `TozsamoscUzgodnij` kopiuje je do rejestru). Parametry przyjmuje flagami lub zmiennymi środowiskowymi: `ZASIEJ_EMAIL_MICHAL` (wymagany), `ZASIEJ_EMAIL_SZYMON`, `ZASIEJ_OSOBA_MICHAL`, `ZASIEJ_OSOBA_SZYMON`, `ZASIEJ_DISCORD_MICHAL`, `ZASIEJ_DISCORD_SZYMON`, `ZASIEJ_SEKRET_GITHUB`. Zmiennej `COGNIFLY_PULA` już nie ma. Domyślnie to DRY-RUN: najpierw sprawdź wypisany plan, dopiero potem dodaj `--wykonaj`.

```
export AWS_REGION=eu-central-1
export ZASIEJ_EMAIL_MICHAL=michal@twoja-domena.pl
npx tsx infra/skrypty/zasiej-pilot.ts            # plan, nic nie jest zapisywane
npx tsx infra/skrypty/zasiej-pilot.ts --wykonaj  # zapis
```

Adresów webhooków Discorda nie wpisuj do historii powłoki, jeśli to możliwe (przekaż przez zmienną ustawioną w tej samej sesji i wyczyść ją po użyciu).
