# Polityka prywatności — Onet Post Companion

**Onet Post Companion** nie prowadzi własnej analityki, nie profiluje użytkowników i nie wysyła danych do serwerów autora rozszerzenia ani do zewnętrznych usług analitycznych.

Rozszerzenie działa wyłącznie w obrębie **Onet Poczty** i korzysta z bieżącej, zalogowanej sesji użytkownika w celu wykonania funkcji opisanych w rozszerzeniu, takich jak zaznaczanie wiadomości, przenoszenie, usuwanie, cofanie/ponawianie operacji oraz automatyczne przenoszenie wybranych wiadomości reklamowych.

## Jakie dane są przetwarzane

Rozszerzenie może lokalnie odczytywać informacje niezbędne do działania interfejsu Onet Poczty, w szczególności identyfikatory wiadomości i folderów oraz adres nadawcy wiadomości używany do rozpoznawania określonego reklamowego nadawcy Onetu.

Dane te są wykorzystywane wyłącznie do wykonania funkcji rozszerzenia i nie są zapisywane na serwerach autora.

## Komunikacja z Onet Pocztą

Niektóre funkcje wykonują żądania do oficjalnego API Onet Poczty (`api.poczta.onet.pl`) w ramach bieżącej sesji użytkownika. Jest to konieczne do realizacji takich operacji jak przenoszenie lub usuwanie wiadomości.

Rozszerzenie nie przekazuje danych pocztowych do żadnych innych podmiotów.

## Przechowywanie lokalne

Historia operacji potrzebna do `Ctrl+Z` / `Ctrl+Y` oraz pomocnicze informacje o bieżącej sesji mogą być przechowywane lokalnie w `sessionStorage` przeglądarki. Dane te pozostają w przeglądarce użytkownika i nie są wysyłane do autora rozszerzenia.

## Kontakt

Kod źródłowy i zgłoszenia dotyczące projektu:
https://github.com/Artllex/onet-post-companion
