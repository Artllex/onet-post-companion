# Onet Post Companion

![Onet Post Companion](icons/icon-256.png)

**Onet Post Companion** to rozszerzenie dla Firefoksa, które usprawnia codzienną pracę z **Onet Pocztą**. Projekt powstał jako zestaw praktycznych skrótów i automatyzacji dla osób, które chcą obsługiwać skrzynkę szybciej, przede wszystkim z klawiatury.

Aktualna wersja: **0.1.5**.

> Projekt niezależny. Nie jest oficjalnym produktem ani rozszerzeniem Grupy Onet.

## Najważniejsze funkcje

- **↑ / ↓** — poruszanie się po wiadomościach bez otwierania ich.
- **Spacja** — zaznaczanie lub odznaczanie aktywnej wiadomości.
- **Shift + ↑ / ↓** — rozszerzanie i zwężanie ciągłego zakresu zaznaczenia.
- **S** — przełączanie gwiazdki aktywnej wiadomości.
  - Przy wielu zaznaczonych wiadomościach stan jest ujednolicany:
    - jeśli choć jedna nie ma gwiazdki → wszystkie dostają gwiazdkę,
    - jeśli wszystkie mają gwiazdkę → gwiazdka jest usuwana wszystkim.
- **Delete / Backspace** — szybkie usuwanie.
- Obsługa **wielu zaznaczonych wiadomości** jednym usunięciem.
- **Esc** — anulowanie / czyszczenie zaznaczenia.
- **Enter** — potwierdzanie natywnych okien dialogowych Onetu.
- **Ctrl+Z / Ctrl+Y** — wielopoziomowe cofanie i ponawianie przeniesień/usunięć.
- Brak zbędnego pełnego przeładowania strony podczas zwykłego usuwania.
- Automatyczne przenoszenie do Kosza wiadomości reklamowych od `mailing_reklamowy@grupaonet.pl`.
- Obsługa wierszy, w których checkbox pojawia się dopiero po najechaniu kursorem.
- Oficjalna ikona projektu jest używana także jako ikona rozszerzenia na pasku Firefoksa.

## Sterowanie

| Klawisz | Działanie |
|---|---|
| `↑` / `↓` | Zmiana aktywnej wiadomości |
| `Spacja` | Zaznacz / odznacz aktywną wiadomość |
| `Shift + ↑ / ↓` | Rozszerz / zwęź zakres zaznaczenia |
| `S` | Gwiazdka / ujednolicenie gwiazdek |
| `Delete` / `Backspace` | Usuń zaznaczoną wiadomość / wiadomości |
| `Esc` | Anuluj / odznacz |
| `Enter` | Potwierdź natywne okno Onetu |
| `Ctrl+Z` | Cofnij ostatnią operację przeniesienia/usunięcia |
| `Ctrl+Y` | Ponów cofniętą operację |

## Prywatność

Rozszerzenie działa lokalnie w przeglądarce i komunikuje się z interfejsem oraz API Onet Poczty w ramach bieżącej zalogowanej sesji. Nie wysyła treści skrzynki do zewnętrznych usług ani serwerów projektu.

Szczegóły: [PRIVACY.md](PRIVACY.md)

## Ikona

Oficjalna ikona projektu znajduje się w `icons/icon-original.png`. Jest to **dokładnie obraz wybrany dla projektu**; mniejsze warianty są wyłącznie technicznymi przeskalowaniami dla Firefoksa.

## Licencja

Projekt jest udostępniany na licencji [MIT](LICENSE).
