/**
 * Onet Post Companion v0.1.3
 * Firefox extension content script.
 *
 * Based on the stable Onet Poczta userscript branch v4.8.19.
 * Runs automatically on https://poczta.onet.pl/*
 */
(function () {
    'use strict';

    console.log('ONET DELETE 4.8.22: skrypt uruchomiony');

    let cachedYesButton = null;
    let cachedCancelButton = null;
    let cacheValidUntil = 0;


    // ============================================================
    // CTRL+Z — DYNAMICZNE PRZECHWYTYWANIE PATCH API ONETU
    // ============================================================

    const ONET_MAIL_API =
        'https://api.poczta.onet.pl/webmailapi/mail/?mailsGroup=1';

    const API_CAPTURE_EVENT =
        '__ONET_DELETE_MAIL_PATCH_V4819__';

    const UNDO_STORAGE_KEY =
        'onet-delete-api-undo-stack-v4.8.19';

    const REDO_STORAGE_KEY =
        'onet-delete-api-redo-stack-v4.8.19';

    /*
     * Historia jest ograniczona liczbą operacji, a nie czasem.
     * sessionStorage i tak dotyczy bieżącej sesji karty.
     */
    const HISTORY_LIMIT =
        100;

    /*
     * Jeśli aplikacja Onetu właśnie wykonuje zewnętrzne przeniesienie,
     * Ctrl+Z może zostać naciśnięte zanim PATCH zdąży odpowiedzieć.
     * Ten znacznik pozwala wtedy chwilę zaczekać na przechwycenie historii.
     */
    let externalMovePendingUntil =
        0;

    /*
     * PATCH-y wykonywane przez nasze Ctrl+Z / Ctrl+Y też przechodzą przez
     * window.fetch. Licznik zapobiega zapisywaniu ich jako nowych ręcznych
     * operacji użytkownika.
     */
    let internalMoveRequestDepth =
        0;

    let undoStack =
        [];

    let redoStack =
        [];

    let undoInProgress =
        false;

    let redoInProgress =
        false;


    // ============================================================
    // AUTOMATYCZNE USUWANIE REKLAM — API
    // ============================================================

    const AUTO_AD_SENDER =
        'mailing_reklamowy@grupaonet.pl';

    const ONET_FOLDER_API =
        'https://api.poczta.onet.pl/webmailapi/folder';

    /*
     * Znamy ten ID z przechwyconego PATCH-a na tym koncie.
     * Używany tylko jako awaryjny fallback, bo v4.8 najpierw
     * próbuje odkryć Kosz dynamicznie z /webmailapi/folder.
     */
    const FALLBACK_TRASH_FOLDER_ID =
        78681;

    const AUTO_AD_HANDLED_KEY =
        'onet-delete-auto-ad-handled-v4.8.19';

    let trashFolderId =
        null;

    let autoAdDeleteInProgress =
        false;

    let autoAdHandledIds =
        new Set();


    // ============================================================
    // CACHE ID MAIL -> ID FOLDERU
    // ============================================================

    const mailFolderByMid =
        new Map();

    let bulkDeleteInProgress =
        false;


    // ============================================================
    // NAWIGACJA STRZAŁKAMI PO WIADOMOŚCIACH
    // ============================================================

    let keyboardFocusIndex =
        null;

    let keyboardFocusKey =
        null;

    /*
     * Punkt zakotwiczenia dla Shift+Arrow.
     * Ustawiany przy pierwszym rozszerzeniu zakresu albo po Spacji.
     */
    let keyboardShiftAnchorKey =
        null;

    let keyboardNavigationBusy =
        false;

    const KEYBOARD_FOCUS_ATTR =
        'data-onet-keyboard-focus';

    const KEYBOARD_FOCUS_STYLE_ID =
        '__onet_keyboard_focus_style_v485';


    // ============================================================
    // GŁÓWNY DOKUMENT
    // ============================================================

    function getMainDocument() {
        try {
            return window.top.document;
        } catch {
            return document;
        }
    }


    // ============================================================
    // POMOCNICZE
    // ============================================================

    function cleanText(value) {
        return (value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }


    function isVisible(el) {
        if (!el || el.nodeType !== 1) {
            return false;
        }

        const win = el.ownerDocument?.defaultView;

        if (!win) {
            return false;
        }

        const style = win.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0
        );
    }


    function isTyping(event) {
        let el = event.target;

        if (!el || el.nodeType !== 1) {
            el = event.view?.document?.activeElement;
        }

        if (!el || el.nodeType !== 1) {
            return false;
        }

        return (
            el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            el.isContentEditable ||
            Boolean(
                el.closest?.('[contenteditable="true"]')
            )
        );
    }


    // ============================================================
    // LEKKIE SZUKANIE PRZYCISKU PO NAPISIE
    // ============================================================

    function findButtonByText(doc, wantedText) {
        const selectors = [
            'button',
            '[role="button"]',
            'input[type="button"]',
            'input[type="submit"]',
            'a[role="button"]'
        ];

        const elements =
            doc.querySelectorAll(
                selectors.join(',')
            );

        for (const el of elements) {
            if (!isVisible(el)) {
                continue;
            }

            const labels = [
                el.innerText,
                el.textContent,
                el.getAttribute('aria-label'),
                el.getAttribute('title'),
                el.getAttribute('value'),
                el.value
            ];

            for (const label of labels) {
                if (cleanText(label) === wantedText) {
                    return el;
                }
            }
        }

        return null;
    }


    // ============================================================
    // POTWIERDZENIE SPAM
    // ============================================================

    function locateConfirmationButtons() {
        const doc = getMainDocument();

        const yes =
            findButtonByText(doc, 'Tak');

        const cancel =
            findButtonByText(doc, 'Anuluj');

        if (
            yes &&
            cancel
        ) {
            cachedYesButton = yes;
            cachedCancelButton = cancel;
            cacheValidUntil =
                performance.now() + 5000;

            /*
             * Ustawiamy fokus na "Tak".
             */
            try {
                yes.focus({
                    preventScroll: true
                });
            } catch {
                try {
                    yes.focus();
                } catch {}
            }

            console.log(
                'ONET DELETE 4.8.22: znaleziono modal',
                { yes, cancel }
            );

            return true;
        }

        return false;
    }


    function getConfirmationButton(which) {
        const now =
            performance.now();

        if (
            now <= cacheValidUntil &&
            cachedYesButton?.isConnected &&
            cachedCancelButton?.isConnected &&
            isVisible(cachedYesButton) &&
            isVisible(cachedCancelButton)
        ) {
            return (
                which === 'yes'
                    ? cachedYesButton
                    : cachedCancelButton
            );
        }

        if (!locateConfirmationButtons()) {
            return null;
        }

        return (
            which === 'yes'
                ? cachedYesButton
                : cachedCancelButton
        );
    }


    function clearConfirmationCache() {
        cachedYesButton = null;
        cachedCancelButton = null;
        cacheValidUntil = 0;
    }


    function watchForConfirmationBriefly() {
        const started =
            performance.now();

        const timer =
            setInterval(
                () => {
                    if (
                        locateConfirmationButtons() ||
                        performance.now() - started > 2000
                    ) {
                        clearInterval(timer);
                    }
                },
                50
            );
    }


    // ============================================================
    // ENTER = TAK / ESC = ANULUJ
    // ============================================================

    function handleConfirmationKeys(event) {
        const isEnter =
            event.key === 'Enter' ||
            event.code === 'Enter' ||
            event.keyCode === 13;

        const isEscape =
            event.key === 'Escape' ||
            event.key === 'Esc' ||
            event.code === 'Escape' ||
            event.keyCode === 27;

        if (!isEnter && !isEscape) {
            return;
        }

        const button =
            getConfirmationButton(
                isEnter ? 'yes' : 'cancel'
            );

        if (!button) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        console.log(
            isEnter
                ? 'ONET DELETE 4.8.22: Enter -> Tak'
                : 'ONET DELETE 4.8.22: Esc -> Anuluj'
        );

        button.click();

        clearConfirmationCache();
    }


    // ============================================================
    // ESC = ODZNACZ ZAZNACZONE WIADOMOŚCI
    // ============================================================

    function getSelectedMailRows() {
        const doc =
            getMainDocument();

        /*
         * Na podstawie rzeczywistego DOM Onetu:
         *
         * <li id="MailItem_..."
         *     class="list-item ... is-checked">
         *
         * Klasa "is-checked" jest dodawana bezpośrednio do
         * zaznaczonego wiersza wiadomości.
         */
        return [
            ...doc.querySelectorAll(
                'li.list-item.is-checked'
            )
        ];
    }


    function findRowCheckboxButton(row) {
        if (!row) {
            return null;
        }


        const main =
            row.querySelector(
                ':scope > div[role="button"]'
            );


        if (!main) {
            return null;
        }


        const firstCell =
            main.firstElementChild;


        if (!firstCell) {
            return null;
        }


        /*
         * W niektórych mailach Onet pokazuje w pierwszej komórce
         * ikonę nadawcy (np. Allegro), a checkbox ujawnia dopiero po hover.
         *
         * Sam przycisk checkboxa nadal istnieje w DOM, tylko jest
         * wizualnie ukryty. Dlatego NIE wymagamy isVisible().
         */
        const buttons =
            [
                ...firstCell.querySelectorAll(
                    'button[type="button"], button'
                )
            ];


        if (
            buttons.length ===
                0
        ) {
            return null;
        }


        /*
         * Preferujemy przycisk, który nie wygląda jak dekoracyjna ikona
         * nadawcy. Checkbox zwykle jest pierwszym buttonem w tej komórce.
         */
        return buttons[0];
    }


    function clickOnetControl(
        button
    ) {
        if (!button) {
            return false;
        }


        try {
            button.click();
            return true;
        } catch {}


        try {
            const win =
                button.ownerDocument
                    ?.defaultView ||
                window;


            button.dispatchEvent(
                new win.MouseEvent(
                    'click',
                    {
                        bubbles:
                            true,

                        cancelable:
                            true,

                        composed:
                            true,

                        view:
                            win
                    }
                )
            );


            return true;

        } catch {}


        return false;
    }


    async function resolveRowCheckboxButton(
        row
    ) {
        if (!row) {
            return null;
        }


        /*
         * Najpierw próbujemy od razu.
         */
        let button =
            findRowCheckboxButton(
                row
            );


        if (
            button &&
            isVisible(
                button
            )
        ) {
            return button;
        }


        /*
         * W wierszach z ikoną nadawcy (np. Allegro) checkbox jest
         * ujawniany dopiero po hover. Symulujemy hover klawiaturą.
         */
        const key =
            getStableRowKey(
                row
            );


        function fireHover(
            element
        ) {
            if (!element) {
                return;
            }

            const win =
                element.ownerDocument
                    ?.defaultView ||
                window;


            const events = [
                ['pointerover', true],
                ['pointerenter', false],
                ['mouseover', true],
                ['mouseenter', false]
            ];


            for (
                const [
                    type,
                    bubbles
                ]
                of events
            ) {
                try {
                    const Ctor =
                        type.startsWith(
                            'pointer'
                        ) &&
                        typeof win.PointerEvent ===
                            'function'
                            ? win.PointerEvent
                            : win.MouseEvent;


                    element.dispatchEvent(
                        new Ctor(
                            type,
                            {
                                bubbles,
                                cancelable:
                                    true,
                                composed:
                                    true,
                                view:
                                    win
                            }
                        )
                    );

                } catch {}
            }
        }


        fireHover(
            row
        );

        fireHover(
            row.querySelector(
                ':scope > div[role="button"]'
            )
        );


        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    100
                )
        );


        /*
         * React mógł podmienić wiersz po hover — pobieramy świeży.
         */
        let freshRow =
            row;


        if (
            key
        ) {
            freshRow =
                getNavigableMailRows()
                    .find(
                        item =>
                            getStableRowKey(
                                item
                            ) === key
                    ) ||
                row;
        }


        button =
            findRowCheckboxButton(
                freshRow
            );


        /*
         * Po hover checkbox może być nadal niewidoczny z punktu widzenia
         * getBoundingClientRect, ale przycisk istnieje i .click() działa.
         */
        return (
            button ||
            null
        );
    }


    function deselectSelectedEmails() {
        const rows =
            getSelectedMailRows();

        if (
            rows.length === 0
        ) {
            return false;
        }


        /*
         * Najpierw sprawdzamy, czy KAŻDY zaznaczony wiersz ma
         * jednoznacznie znaleziony przycisk checkboxa.
         *
         * Jeżeli choć jednego nie potrafimy znaleźć,
         * nie klikamy niczego.
         */
        const buttons =
            rows.map(
                findRowCheckboxButton
            );

        if (
            buttons.some(
                button => !button
            )
        ) {
            console.log(
                'ONET DELETE 4.8.22: Esc -> wykryto zaznaczone maile, ale nie znaleziono wszystkich checkboxów; nic nie klikam',
                rows
            );

            return false;
        }


        console.log(
            `ONET DELETE 4.8.22: Esc -> odznaczam ${buttons.length} wiadomość/wiadomości`
        );


        /*
         * Klikamy od końca.
         *
         * Dzięki temu ewentualne przerysowanie listy przez Reacta
         * ma mniejsze szanse wpłynąć na jeszcze nieobsłużone wiersze.
         */
        for (
            let i = buttons.length - 1;
            i >= 0;
            i--
        ) {
            try {
                buttons[i].click();
            } catch {}
        }


        return true;
    }


    function handleEscapeDeselect(event) {
        const isEscape =
            event.key === 'Escape' ||
            event.key === 'Esc' ||
            event.code === 'Escape' ||
            event.keyCode === 27;

        if (!isEscape) {
            return;
        }


        /*
         * Nie przejmujemy Esc podczas pisania.
         */
        if (
            isTyping(event)
        ) {
            return;
        }


        /*
         * Jeżeli jest otwarty modal potwierdzenia,
         * Esc oznacza "Anuluj", a nie odznaczenie maili.
         */
        if (
            getConfirmationButton('cancel')
        ) {
            return;
        }


        if (
            !deselectSelectedEmails()
        ) {
            return;
        }


        resetKeyboardFocus();


        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }



    // ============================================================
    // PRZECHWYTYWANIE window.fetch
    // ============================================================

    function isOnetMailPatchUrl(value) {
        try {
            const url =
                new URL(
                    value,
                    location.href
                );

            return (
                url.hostname ===
                    'api.poczta.onet.pl' &&
                url.pathname ===
                    '/webmailapi/mail/' &&
                url.searchParams.get(
                    'mailsGroup'
                ) === '1'
            );

        } catch {
            return false;
        }
    }


    function tryParseJsonBody(body) {
        if (
            typeof body !==
            'string'
        ) {
            return null;
        }

        try {
            return JSON.parse(
                body
            );
        } catch {
            return null;
        }
    }


    function isMovePayload(payload) {
        if (
            !payload ||
            typeof payload !==
                'object'
        ) {
            return false;
        }

        const dstFolder =
            Number(
                payload.dstFolder
            );

        if (
            !Number.isSafeInteger(
                dstFolder
            )
        ) {
            return false;
        }

        const srcMails =
            payload.srcMails;

        if (
            !srcMails ||
            typeof srcMails !==
                'object' ||
            Array.isArray(
                srcMails
            )
        ) {
            return false;
        }

        const groups =
            Object.entries(
                srcMails
            );

        if (
            groups.length === 0
        ) {
            return false;
        }

        return groups.every(
            ([folderId, mailIds]) => {
                const sourceFolder =
                    Number(
                        folderId
                    );

                return (
                    Number.isSafeInteger(
                        sourceFolder
                    ) &&
                    Array.isArray(
                        mailIds
                    ) &&
                    mailIds.length >
                        0 &&
                    mailIds.every(
                        id =>
                            Number.isSafeInteger(
                                Number(
                                    id
                                )
                            )
                    )
                );
            }
        );
    }



    // ============================================================
    // AUTOMATYCZNE REKLAMY — ODCZYT ODPOWIEDZI API
    // ============================================================

    function loadAutoAdHandledIds() {
        try {
            const raw =
                sessionStorage.getItem(
                    AUTO_AD_HANDLED_KEY
                );

            if (!raw) {
                return;
            }

            const parsed =
                JSON.parse(
                    raw
                );

            if (
                Array.isArray(
                    parsed
                )
            ) {
                autoAdHandledIds =
                    new Set(
                        parsed
                            .map(
                                Number
                            )
                            .filter(
                                Number.isSafeInteger
                            )
                    );
            }

        } catch {}
    }


    function saveAutoAdHandledIds() {
        try {
            sessionStorage.setItem(
                AUTO_AD_HANDLED_KEY,
                JSON.stringify(
                    [
                        ...autoAdHandledIds
                    ]
                )
            );
        } catch {}
    }


    function extractEmailAddress(
        fromValue
    ) {
        const text =
            String(
                fromValue ||
                ''
            )
                .trim();


        const angle =
            text.match(
                /<\s*([^<>@\s]+@[^<>\s]+)\s*>/
            );


        const candidate =
            (
                angle?.[1] ||
                text
            )
                .replace(
                    /^["']|["']$/g,
                    ''
                )
                .trim()
                .toLocaleLowerCase(
                    'en-US'
                );


        return candidate;
    }


    function isAdvertisingMailRecord(
        mail
    ) {
        if (
            !mail ||
            typeof mail !==
                'object'
        ) {
            return false;
        }


        return (
            extractEmailAddress(
                mail.from
            ) ===
            AUTO_AD_SENDER
        );
    }


    function isOnetMailListUrl(
        value
    ) {
        try {
            const url =
                new URL(
                    value,
                    location.href
                );

            return (
                url.hostname ===
                    'api.poczta.onet.pl' &&
                url.pathname
                    .replace(
                        /\/+$/,
                        ''
                    ) ===
                    '/webmailapi/mail' &&
                !url.searchParams.has(
                    'mailsGroup'
                )
            );

        } catch {
            return false;
        }
    }


    function isOnetFolderUrl(
        value
    ) {
        try {
            const url =
                new URL(
                    value,
                    location.href
                );

            return (
                url.hostname ===
                    'api.poczta.onet.pl' &&
                url.pathname
                    .replace(
                        /\/+$/,
                        ''
                    ) ===
                    '/webmailapi/folder'
            );

        } catch {
            return false;
        }
    }


    function findTrashFolderIdDeep(
        value,
        visited =
            new Set()
    ) {
        if (
            value == null ||
            typeof value !==
                'object' ||
            visited.has(
                value
            )
        ) {
            return null;
        }


        visited.add(
            value
        );


        if (
            !Array.isArray(
                value
            )
        ) {
            const entries =
                Object.entries(
                    value
                );


            const hasTrashName =
                entries.some(
                    ([key, val]) =>
                        typeof val ===
                            'string' &&
                        (
                            /name|title|label|folder/i.test(
                                key
                            ) ||
                            entries.length <
                                12
                        ) &&
                        val
                            .trim()
                            .toLocaleLowerCase(
                                'pl-PL'
                            ) ===
                            'kosz'
                );


            if (
                hasTrashName
            ) {
                const preferredKeys = [
                    'fid',
                    'id',
                    'folderId',
                    'folder_id'
                ];


                for (
                    const key
                    of preferredKeys
                ) {
                    const id =
                        Number(
                            value[
                                key
                            ]
                        );


                    if (
                        Number.isSafeInteger(
                            id
                        )
                    ) {
                        return id;
                    }
                }
            }
        }


        const children =
            Array.isArray(
                value
            )
                ? value
                : Object.values(
                    value
                );


        for (
            const child
            of children
        ) {
            const found =
                findTrashFolderIdDeep(
                    child,
                    visited
                );


            if (
                Number.isSafeInteger(
                    found
                )
            ) {
                return found;
            }
        }


        return null;
    }


    async function inspectFolderResponse(
        response
    ) {
        try {
            const data =
                await response
                    .json();


            const found =
                findTrashFolderIdDeep(
                    data
                );


            if (
                Number.isSafeInteger(
                    found
                )
            ) {
                trashFolderId =
                    found;


                console.log(
                    'ONET DELETE 4.8.22: wykryto ID Kosza',
                    trashFolderId
                );
            }

        } catch {}
    }


    async function ensureTrashFolderId() {
        if (
            Number.isSafeInteger(
                trashFolderId
            )
        ) {
            return trashFolderId;
        }


        try {
            const response =
                await fetch(
                    ONET_FOLDER_API,
                    {
                        method:
                            'GET',

                        mode:
                            'cors',

                        credentials:
                            'include',

                        headers: {
                            'Accept':
                                'application/json'
                        }
                    }
                );


            if (
                response.ok
            ) {
                const data =
                    await response
                        .clone()
                        .json();


                const found =
                    findTrashFolderIdDeep(
                        data
                    );


                if (
                    Number.isSafeInteger(
                        found
                    )
                ) {
                    trashFolderId =
                        found;

                    return found;
                }
            }

        } catch {}


        /*
         * Fallback potwierdzony wcześniej w DevTools.
         */
        trashFolderId =
            FALLBACK_TRASH_FOLDER_ID;


        console.log(
            'ONET DELETE 4.8.22: używam fallback ID Kosza',
            trashFolderId
        );


        return trashFolderId;
    }


    function groupAdvertisingMailsBySourceFolder(
        mails,
        trashId
    ) {
        const srcMails =
            {};


        for (
            const mail
            of mails
        ) {
            if (
                !isAdvertisingMailRecord(
                    mail
                )
            ) {
                continue;
            }


            const mid =
                Number(
                    mail.mid
                );

            const fid =
                Number(
                    mail.fid
                );


            if (
                !Number.isSafeInteger(
                    mid
                ) ||
                !Number.isSafeInteger(
                    fid
                ) ||
                fid ===
                    trashId ||
                autoAdHandledIds
                    .has(
                        mid
                    )
            ) {
                continue;
            }


            if (
                !srcMails[
                    fid
                ]
            ) {
                srcMails[
                    fid
                ] =
                    [];
            }


            srcMails[
                fid
            ].push(
                mid
            );
        }


        return srcMails;
    }


    async function autoDeleteAdvertisingRecords(
        mails
    ) {
        if (
            autoAdDeleteInProgress ||
            !Array.isArray(
                mails
            ) ||
            mails.length ===
                0
        ) {
            return;
        }


        autoAdDeleteInProgress =
            true;


        try {
            const trashId =
                await ensureTrashFolderId();


            const srcMails =
                groupAdvertisingMailsBySourceFolder(
                    mails,
                    trashId
                );


            const mailIds =
                Object.values(
                    srcMails
                )
                    .flat();


            if (
                mailIds.length ===
                0
            ) {
                return;
            }


            const payload = {
                dstFolder:
                    trashId,

                srcMails
            };


            console.log(
                'ONET DELETE 4.8.22: automatycznie przenoszę reklamy do Kosza przez API',
                payload
            );


            /*
             * sendMovePatch oznacza ten PATCH jako wewnętrzny,
             * więc interceptor nie zapisze go podwójnie.
             */
            await sendMovePatch(
                payload
            );


            /*
             * Dodajemy automatyczne usunięcie do normalnego,
             * wielopoziomowego Ctrl+Z/Ctrl+Y.
             */
            const inverseRequests =
                buildInverseRequests(
                    payload
                );


            if (
                inverseRequests.length >
                0
            ) {
                pushUndoState({
                    createdAt:
                        Date.now(),

                    originalPayload:
                        payload,

                    inverseRequests
                });

                clearRedoStack();
            }


            /*
             * Jeśli użytkownik cofnie auto-delete przez Ctrl+Z,
             * ten sam mail nie zostanie natychmiast ponownie
             * usunięty po reloadzie w tej samej sesji.
             */
            for (
                const mid
                of mailIds
            ) {
                autoAdHandledIds
                    .add(
                        mid
                    );
            }


            saveAutoAdHandledIds();


            showUndoNotice(
                mailIds.length === 1
                    ? 'Automatycznie usunięto reklamę.'
                    : `Automatycznie usunięto ${mailIds.length} reklam.`
            );


            /*
             * Nie przechodzimy do żadnego folderu.
             * Tylko odświeżamy bieżący widok po zmianie backendu.
             */
            setTimeout(
                () => {
                    try {
                        window.top
                            .location
                            .reload();
                    } catch {
                        location.reload();
                    }
                },
                350
            );

        } catch (
            error
        ) {
            console.error(
                'ONET DELETE 4.8.22: auto-delete reklam nie powiódł się',
                error
            );

        } finally {
            autoAdDeleteInProgress =
                false;
        }
    }


    async function inspectMailListResponse(
        response
    ) {
        try {
            const data =
                await response
                    .json();


            if (
                !Array.isArray(
                    data?.mails
                )
            ) {
                return;
            }


            /*
             * Zapamiętujemy folder źródłowy każdego maila z aktualnie
             * pobranej listy. Dzięki temu wielokrotny Delete może wysłać
             * jeden precyzyjny PATCH bez polegania na kliku toolbaru.
             */
            for (
                const mail
                of data.mails
            ) {
                const mid =
                    Number(
                        mail?.mid
                    );

                const fid =
                    Number(
                        mail?.fid
                    );

                if (
                    Number.isSafeInteger(
                        mid
                    ) &&
                    Number.isSafeInteger(
                        fid
                    )
                ) {
                    mailFolderByMid.set(
                        mid,
                        fid
                    );
                }
            }


            const count =
                data.mails
                    .filter(
                        isAdvertisingMailRecord
                    )
                    .length;


            console.log(
                `ONET DELETE 4.8.22: API lista -> ${count} reklam od ${AUTO_AD_SENDER}`
            );


            if (
                count >
                0
            ) {
                await autoDeleteAdvertisingRecords(
                    data.mails
                );
            }

        } catch (
            error
        ) {
            console.error(
                'ONET DELETE 4.8.22: nie udało się przeanalizować listy maili',
                error
            );
        }
    }


    function installFetchInterceptor() {
        if (
            window
                .__ONET_DELETE_FETCH_PATCHED_V4819__
        ) {
            return;
        }

        const originalFetch =
            window.fetch;

        if (
            typeof originalFetch !==
            'function'
        ) {
            return;
        }

        window
            .__ONET_DELETE_FETCH_PATCHED_V4819__ =
            true;


        window.fetch =
            async function (
                input,
                init
            ) {
                let url =
                    '';

                let method =
                    'GET';

                let body =
                    null;


                try {
                    if (
                        typeof input ===
                            'string'
                    ) {
                        url =
                            input;

                    } else if (
                        input?.url
                    ) {
                        url =
                            input.url;
                    }


                    method =
                        String(
                            init?.method ||
                            input?.method ||
                            'GET'
                        )
                            .toUpperCase();


                    body =
                        init?.body ??
                        null;


                    if (
                        body == null &&
                        typeof Request !==
                            'undefined' &&
                        input instanceof
                            Request
                    ) {
                        try {
                            body =
                                await input
                                    .clone()
                                    .text();
                        } catch {}
                    }

                } catch {}


                const payload =
                    (
                        method ===
                            'PATCH' &&
                        isOnetMailPatchUrl(
                            url
                        )
                    )
                        ? tryParseJsonBody(
                            body
                        )
                        : null;


                const isExternalMove =
                    (
                        method ===
                            'PATCH' &&
                        isOnetMailPatchUrl(
                            url
                        ) &&
                        isMovePayload(
                            payload
                        ) &&
                        internalMoveRequestDepth ===
                            0
                    );


                if (
                    isExternalMove
                ) {
                    externalMovePendingUntil =
                        Date.now() +
                        4000;
                }


                let response;

                try {
                    response =
                        await originalFetch
                            .apply(
                                this,
                                arguments
                            );

                } finally {
                    if (
                        isExternalMove &&
                        !response?.ok
                    ) {
                        externalMovePendingUntil =
                            0;
                    }
                }


                /*
                 * Ręczne Delete / Przenieś -> historia Ctrl+Z/Ctrl+Y.
                 */
                if (
                    response?.ok &&
                    isExternalMove
                ) {
                    try {
                        document
                            .dispatchEvent(
                                new CustomEvent(
                                    API_CAPTURE_EVENT,
                                    {
                                        detail: {
                                            at:
                                                Date.now(),

                                            payload
                                        }
                                    }
                                )
                            );
                    } catch {}

                    externalMovePendingUntil =
                        0;
                }


                /*
                 * GET /folder -> dynamiczne odkrycie ID Kosza.
                 */
                if (
                    response?.ok &&
                    method ===
                        'GET' &&
                    isOnetFolderUrl(
                        url
                    )
                ) {
                    inspectFolderResponse(
                        response.clone()
                    );
                }


                /*
                 * GET /mail -> wykrywanie reklam po prawdziwym
                 * polu `from` w JSON, a nie po DOM.
                 */
                if (
                    response?.ok &&
                    method ===
                        'GET' &&
                    isOnetMailListUrl(
                        url
                    )
                ) {
                    inspectMailListResponse(
                        response.clone()
                    );
                }


                return response;
            };


        console.log(
            'ONET DELETE 4.8.22: przechwytuję PATCH oraz GET API Onetu'
        );
    }


    // ============================================================
    // BUDOWANIE OPERACJI ODWROTNEJ
    // ============================================================

    function flattenMailIdsFromPayload(
        payload
    ) {
        const result =
            [];

        for (
            const ids
            of Object.values(
                payload?.srcMails ||
                {}
            )
        ) {
            if (
                !Array.isArray(
                    ids
                )
            ) {
                continue;
            }

            for (
                const id
                of ids
            ) {
                const numeric =
                    Number(
                        id
                    );

                if (
                    Number.isSafeInteger(
                        numeric
                    )
                ) {
                    result.push(
                        numeric
                    );
                }
            }
        }

        return result;
    }


    function buildInverseRequests(
        payload
    ) {
        if (
            !isMovePayload(
                payload
            )
        ) {
            return [];
        }

        const originalDestination =
            Number(
                payload.dstFolder
            );

        const requests =
            [];


        /*
         * Ogólna inwersja:
         *
         * ORYGINAŁ:
         * dstFolder = D
         * srcMails = {
         *   S1: [A, B],
         *   S2: [C]
         * }
         *
         * CTRL+Z:
         * 1) dstFolder = S1, srcMails = { D: [A, B] }
         * 2) dstFolder = S2, srcMails = { D: [C] }
         *
         * Dzięki temu nie musimy znać ŻADNYCH ID folderów
         * z góry.
         */
        for (
            const [
                sourceFolderRaw,
                idsRaw
            ]
            of Object.entries(
                payload.srcMails
            )
        ) {
            const sourceFolder =
                Number(
                    sourceFolderRaw
                );

            const mailIds =
                idsRaw
                    .map(
                        id =>
                            Number(
                                id
                            )
                    )
                    .filter(
                        Number.isSafeInteger
                    );


            if (
                !Number.isSafeInteger(
                    sourceFolder
                ) ||
                mailIds.length ===
                    0
            ) {
                continue;
            }


            requests.push({
                dstFolder:
                    sourceFolder,

                srcMails: {
                    [originalDestination]:
                        mailIds
                }
            });
        }


        return requests;
    }


    // ============================================================
    // WIELOPOZIOMOWA PAMIĘĆ CTRL+Z / CTRL+Y
    // ============================================================

    function getSessionStorageSafe() {
        try {
            return window
                .sessionStorage;
        } catch {
            return null;
        }
    }


    function sanitizeHistoryEntry(
        state
    ) {
        if (
            !state ||
            !isMovePayload(
                state.originalPayload
            ) ||
            !Array.isArray(
                state.inverseRequests
            ) ||
            state.inverseRequests.length ===
                0 ||
            !state.inverseRequests
                .every(
                    isMovePayload
                )
        ) {
            return null;
        }

        return {
            createdAt:
                Number(
                    state.createdAt
                ) ||
                Date.now(),

            originalPayload:
                state.originalPayload,

            inverseRequests:
                state.inverseRequests
        };
    }


    function sanitizeHistoryStack(
        value
    ) {
        if (
            !Array.isArray(
                value
            )
        ) {
            return [];
        }

        return value
            .map(
                sanitizeHistoryEntry
            )
            .filter(
                Boolean
            )
            .slice(
                -HISTORY_LIMIT
            );
    }


    function saveUndoStack() {
        undoStack =
            sanitizeHistoryStack(
                undoStack
            );

        try {
            getSessionStorageSafe()
                ?.setItem(
                    UNDO_STORAGE_KEY,
                    JSON.stringify(
                        undoStack
                    )
                );
        } catch {}
    }


    function saveRedoStack() {
        redoStack =
            sanitizeHistoryStack(
                redoStack
            );

        try {
            getSessionStorageSafe()
                ?.setItem(
                    REDO_STORAGE_KEY,
                    JSON.stringify(
                        redoStack
                    )
                );
        } catch {}
    }


    function loadHistoryStacks() {
        let storedUndo =
            [];

        let storedRedo =
            [];


        try {
            const raw =
                getSessionStorageSafe()
                    ?.getItem(
                        UNDO_STORAGE_KEY
                    );

            if (raw) {
                storedUndo =
                    JSON.parse(
                        raw
                    );
            }
        } catch {}


        try {
            const raw =
                getSessionStorageSafe()
                    ?.getItem(
                        REDO_STORAGE_KEY
                    );

            if (raw) {
                storedRedo =
                    JSON.parse(
                        raw
                    );
            }
        } catch {}


        undoStack =
            sanitizeHistoryStack(
                storedUndo
            );

        redoStack =
            sanitizeHistoryStack(
                storedRedo
            );


        saveUndoStack();
        saveRedoStack();


        console.log(
            'ONET DELETE 4.8.22: historia wczytana',
            {
                undo:
                    undoStack.length,

                redo:
                    redoStack.length
            }
        );
    }


    function clearUndoStack() {
        undoStack =
            [];

        saveUndoStack();
    }


    function clearRedoStack() {
        redoStack =
            [];

        saveRedoStack();
    }


    function pushUndoState(
        state
    ) {
        const safe =
            sanitizeHistoryEntry(
                state
            );

        if (!safe) {
            return false;
        }

        undoStack.push(
            safe
        );

        if (
            undoStack.length >
            HISTORY_LIMIT
        ) {
            undoStack =
                undoStack.slice(
                    -HISTORY_LIMIT
                );
        }

        saveUndoStack();

        return true;
    }


    function pushRedoState(
        state
    ) {
        const safe =
            sanitizeHistoryEntry(
                state
            );

        if (!safe) {
            return false;
        }

        redoStack.push(
            safe
        );

        if (
            redoStack.length >
            HISTORY_LIMIT
        ) {
            redoStack =
                redoStack.slice(
                    -HISTORY_LIMIT
                );
        }

        saveRedoStack();

        return true;
    }


    function peekUndoState() {
        return (
            undoStack[
                undoStack.length - 1
            ] ||
            null
        );
    }


    function peekRedoState() {
        return (
            redoStack[
                redoStack.length - 1
            ] ||
            null
        );
    }


    function popUndoState() {
        const state =
            undoStack.pop() ||
            null;

        saveUndoStack();

        return state;
    }


    function popRedoState() {
        const state =
            redoStack.pop() ||
            null;

        saveRedoStack();

        return state;
    }


    // ============================================================
    // HISTORIA KAŻDEGO PRZENIESIENIA MIĘDZY FOLDERAMI
    // ============================================================

    document.addEventListener(
        API_CAPTURE_EVENT,
        event => {
            const payload =
                event.detail
                    ?.payload;

            if (
                !isMovePayload(
                    payload
                )
            ) {
                return;
            }

            const inverseRequests =
                buildInverseRequests(
                    payload
                );

            if (
                inverseRequests.length ===
                0
            ) {
                return;
            }


            /*
             * Każdy ręczny PATCH "Przenieś" staje się nowym punktem historii.
             *
             * Przykład:
             *
             *     folder A -> folder B
             *
             * Onet wysyła:
             *
             *     dstFolder = B
             *     srcMails = { A: [mail1, mail2] }
             *
             * Ctrl+Z dostaje automatycznie:
             *
             *     dstFolder = A
             *     srcMails = { B: [mail1, mail2] }
             *
             * Nie znamy ani nie zgadujemy żadnego ID folderu.
             */
            const state = {
                createdAt:
                    Date.now(),

                originalPayload:
                    payload,

                inverseRequests
            };


            pushUndoState(
                state
            );


            /*
             * Tak jak w klasycznym Undo/Redo:
             * nowa ręczna operacja kasuje gałąź Redo.
             */
            clearRedoStack();


            console.log(
                'ONET DELETE 4.8.22: przechwycono przeniesienie wiadomości',
                {
                    original:
                        payload,

                    undo:
                        inverseRequests
                }
            );
        },
        true
    );


    // ============================================================
    // CTRL+Z — BEZPOŚREDNI PATCH ODWROTNY
    // ============================================================

    function sleep(
        ms
    ) {
        return new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    ms
                )
        );
    }


    function showUndoNotice(
        message
    ) {
        const doc =
            getMainDocument();

        if (
            !doc?.documentElement
        ) {
            return;
        }

        doc
            .getElementById(
                '__onet_delete_undo_notice'
            )
            ?.remove();

        const box =
            doc.createElement(
                'div'
            );

        box.id =
            '__onet_delete_undo_notice';

        box.textContent =
            message;

        box.style.cssText = [
            'position:fixed',
            'right:20px',
            'bottom:20px',
            'z-index:2147483647',
            'background:rgba(30,30,30,.94)',
            'color:#fff',
            'padding:10px 14px',
            'border-radius:6px',
            'font:14px/1.35 Arial,sans-serif',
            'box-shadow:0 4px 18px rgba(0,0,0,.35)',
            'pointer-events:none'
        ].join(';');

        (
            doc.body ||
            doc.documentElement
        )
            .appendChild(
                box
            );

        setTimeout(
            () =>
                box.remove(),
            2200
        );
    }


    async function sendMovePatch(
        payload
    ) {
        internalMoveRequestDepth++;

        try {
            const response =
                await fetch(
                    ONET_MAIL_API,
                    {
                        method:
                            'PATCH',

                        mode:
                            'cors',

                        credentials:
                            'include',

                        headers: {
                            'Accept':
                                'application/json',

                            'Content-Type':
                                'application/json'
                        },

                        body:
                            JSON.stringify(
                                payload
                            )
                    }
                );

            if (
                !response.ok
            ) {
                throw new Error(
                    `HTTP ${response.status}`
                );
            }

            return response;

        } finally {
            internalMoveRequestDepth =
                Math.max(
                    0,
                    internalMoveRequestDepth -
                        1
                );
        }
    }


    async function waitForUndoState(
        timeout =
            1800
    ) {
        const started =
            Date.now();

        while (
            Date.now() -
                started <
                timeout
        ) {
            const state =
                peekUndoState();

            if (state) {
                return state;
            }

            await sleep(
                50
            );
        }

        return null;
    }


    async function undoLastMove() {
        if (
            undoInProgress
        ) {
            return false;
        }

        let state =
            peekUndoState();


        /*
         * Użytkownik może nacisnąć Ctrl+Z natychmiast po Delete
         * ALBO po ręcznym "Przenieś", zanim odpowiedź PATCH-a wróci.
         */
        if (
            !state &&
            Date.now() <=
                externalMovePendingUntil
        ) {
            state =
                await waitForUndoState();
        }


        if (!state) {
            return false;
        }


        undoInProgress =
            true;


        try {
            for (
                const payload
                of state
                    .inverseRequests
            ) {
                console.log(
                    'ONET DELETE 4.8.22: Ctrl+Z -> PATCH odwrotny',
                    payload
                );

                await sendMovePatch(
                    payload
                );
            }


            const count =
                state.inverseRequests
                    .reduce(
                        (
                            total,
                            request
                        ) =>
                            total +
                            flattenMailIdsFromPayload(
                                request
                            ).length,
                        0
                    );


            /*
             * Usuwamy dokładnie tę operację, którą właśnie cofnęliśmy,
             * z wierzchołka UNDO i przenosimy ją na stos REDO.
             */
            const removed =
                popUndoState();

            pushRedoState(
                removed ||
                state
            );


            showUndoNotice(
                count === 1
                    ? (
                        undoStack.length > 0
                            ? `Cofnięto przeniesienie wiadomości. Pozostało ${undoStack.length} operacji Ctrl+Z.`
                            : 'Cofnięto przeniesienie wiadomości.'
                    )
                    : (
                        undoStack.length > 0
                            ? `Cofnięto przeniesienie ${count} wiadomości. Pozostało ${undoStack.length} operacji Ctrl+Z.`
                            : `Cofnięto przeniesienie ${count} wiadomości.`
                    )
            );


            /*
             * Nie przechodzimy do żadnego folderu.
             * Tylko odświeżamy BIEŻĄCY widok, aby UI pobrał
             * aktualny stan z backendu.
             */
            setTimeout(
                () => {
                    try {
                        window.top
                            .location
                            .reload();
                    } catch {
                        location.reload();
                    }
                },
                350
            );


            return true;

        } catch (
            error
        ) {
            console.error(
                'ONET DELETE 4.8.22: Ctrl+Z nie powiodło się',
                error
            );

            showUndoNotice(
                'Nie udało się cofnąć przeniesienia wiadomości.'
            );

            return false;

        } finally {
            undoInProgress =
                false;
        }
    }


    async function handleUndoShortcut(
        event
    ) {
        const isUndo =
            event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            (
                event.key ===
                    'z' ||
                event.key ===
                    'Z' ||
                event.code ===
                    'KeyZ'
            );

        if (!isUndo) {
            return;
        }


        /*
         * Ctrl+Z w polu edycji nadal oznacza cofanie tekstu.
         */
        if (
            isTyping(event)
        ) {
            return;
        }


        /*
         * Jeżeli otwarty jest modal trwałego usuwania,
         * nie przechwytujemy Ctrl+Z.
         */
        if (
            getConfirmationButton(
                'cancel'
            )
        ) {
            return;
        }


        const hasUndo =
            Boolean(
                peekUndoState()
            ) ||
            Boolean(
                Date.now() <=
                    externalMovePendingUntil
            );


        if (!hasUndo) {
            return;
        }


        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();


        await undoLastMove();
    }



    // ============================================================
    // CTRL+Y — PONOWIENIE USUNIĘCIA
    // ============================================================

    async function redoLastMove() {
        if (
            redoInProgress
        ) {
            return false;
        }

        const state =
            peekRedoState();

        if (!state) {
            return false;
        }


        redoInProgress =
            true;


        try {
            console.log(
                'ONET DELETE 4.8.22: Ctrl+Y -> ponawiam oryginalny PATCH',
                state.originalPayload
            );


            /*
             * Ctrl+Y nie rekonstruuje żadnych folderów ani ID.
             * Wysyła dokładnie oryginalny PATCH przechwycony przy
             * Delete/Backspace.
             */
            await sendMovePatch(
                state.originalPayload
            );


            const count =
                flattenMailIdsFromPayload(
                    state.originalPayload
                ).length;


            /*
             * Operacja została ponowiona: zdejmujemy ją z REDO
             * i odkładamy z powrotem na wierzchołek UNDO.
             */
            const removed =
                popRedoState();

            pushUndoState(
                removed ||
                state
            );


            showUndoNotice(
                count === 1
                    ? (
                        redoStack.length > 0
                            ? `Ponowiono przeniesienie wiadomości. Pozostało ${redoStack.length} operacji Ctrl+Y.`
                            : 'Ponowiono przeniesienie wiadomości.'
                    )
                    : (
                        redoStack.length > 0
                            ? `Ponowiono przeniesienie ${count} wiadomości. Pozostało ${redoStack.length} operacji Ctrl+Y.`
                            : `Ponowiono przeniesienie ${count} wiadomości.`
                    )
            );


            /*
             * Tak jak przy Ctrl+Z nie zmieniamy folderu.
             * Odświeżamy tylko bieżący widok, żeby UI zsynchronizował
             * się z backendem.
             */
            setTimeout(
                () => {
                    try {
                        window.top
                            .location
                            .reload();
                    } catch {
                        location.reload();
                    }
                },
                350
            );


            return true;

        } catch (
            error
        ) {
            console.error(
                'ONET DELETE 4.8.22: Ctrl+Y nie powiodło się',
                error
            );

            showUndoNotice(
                'Nie udało się ponowić przeniesienia wiadomości.'
            );

            return false;

        } finally {
            redoInProgress =
                false;
        }
    }


    async function handleRedoShortcut(
        event
    ) {
        const isRedo =
            event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            (
                event.key ===
                    'y' ||
                event.key ===
                    'Y' ||
                event.code ===
                    'KeyY'
            );


        if (!isRedo) {
            return;
        }


        /*
         * Ctrl+Y w edytorze wiadomości pozostaje standardowym
         * ponowieniem edycji tekstu.
         */
        if (
            isTyping(event)
        ) {
            return;
        }


        /*
         * Nie mieszamy historii usuwania z otwartym modalem.
         */
        if (
            getConfirmationButton(
                'cancel'
            )
        ) {
            return;
        }


        if (
            !peekRedoState()
        ) {
            return;
        }


        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();


        await redoLastMove();
    }




    // ============================================================
    // NAWIGACJA STRZAŁKAMI — LISTA MAILI
    // ============================================================

    function getNavigableMailRows() {
        const doc =
            getMainDocument();

        return [
            ...doc.querySelectorAll(
                'li.list-item'
            )
        ].filter(
            row =>
                isVisible(
                    row
                )
        );
    }


    function getStableRowKey(
        row
    ) {
        return (
            row?.id ||
            null
        );
    }


    function ensureKeyboardFocusStyle() {
        /*
         * v4.8.6 nie polega już na samej regule CSS.
         * Aktywny wiersz dostaje inline-style z !important,
         * żeby Onet nie nadpisywał go własnymi stylami.
         */
    }


    function getKeyboardFocusSurface(
        row
    ) {
        if (!row) {
            return null;
        }

        /*
         * W Onet Poczta widoczną powierzchnią wiersza jest zwykle
         * wewnętrzny DIV role="button", a nie samo LI.
         */
        return (
            row.querySelector(
                ':scope > div[role="button"]'
            ) ||
            row.firstElementChild ||
            row
        );
    }


    function clearKeyboardFocusVisual() {
        const doc =
            getMainDocument();

        for (
            const row
            of doc.querySelectorAll(
                `li.list-item[${KEYBOARD_FOCUS_ATTR}="true"]`
            )
        ) {
            row.removeAttribute(
                KEYBOARD_FOCUS_ATTR
            );

            const surface =
                getKeyboardFocusSurface(
                    row
                );

            if (surface) {
                surface.style.removeProperty(
                    'outline'
                );

                surface.style.removeProperty(
                    'outline-offset'
                );

                surface.style.removeProperty(
                    'box-shadow'
                );

                surface.style.removeProperty(
                    'background-color'
                );
            }
        }
    }


    function resetKeyboardFocus() {
        keyboardFocusIndex =
            null;

        keyboardFocusKey =
            null;

        keyboardShiftAnchorKey =
            null;

        clearKeyboardFocusVisual();
    }


    function setKeyboardFocusVisual(
        row
    ) {
        clearKeyboardFocusVisual();

        if (!row) {
            return;
        }


        row.setAttribute(
            KEYBOARD_FOCUS_ATTR,
            'true'
        );


        const surface =
            getKeyboardFocusSurface(
                row
            );


        if (!surface) {
            return;
        }


        /*
         * Wyróżnienie aktywnego maila ma być wyraźne, ale inne niż
         * niebieskie zaznaczenie checkboxowe Onetu.
         */
        surface.style.setProperty(
            'outline',
            '1px solid rgba(255,255,255,.68)',
            'important'
        );

        surface.style.setProperty(
            'outline-offset',
            '-2px',
            'important'
        );

        /*
         * Bez dodatkowego lewego insetu. Poprzedni box-shadow nakładał się
         * na outline, przez co lewa krawędź wyglądała na grubszą i lekko
         * wystawała ponad/dół wiersza.
         */
        surface.style.removeProperty(
            'box-shadow'
        );

        if (
            !row.classList
                .contains(
                    'is-checked'
                )
        ) {
            surface.style.setProperty(
                'background-color',
                'rgba(255,255,255,.045)',
                'important'
            );
        }


        try {
            row.scrollIntoView({
                block:
                    'nearest'
            });
        } catch {}
    }


    function syncKeyboardFocusToFreshDom() {
        const rows =
            getNavigableMailRows();

        if (!keyboardFocusKey) {
            return {
                rows,
                index:
                    null,
                row:
                    null
            };
        }

        const index =
            rows.findIndex(
                row =>
                    getStableRowKey(
                        row
                    ) ===
                    keyboardFocusKey
            );

        if (
            index <
            0
        ) {
            resetKeyboardFocus();

            return {
                rows,
                index:
                    null,
                row:
                    null
            };
        }

        keyboardFocusIndex =
            index;

        const row =
            rows[index];

        setKeyboardFocusVisual(
            row
        );

        return {
            rows,
            index,
            row
        };
    }


    function focusMailAtIndex(
        rows,
        index
    ) {
        if (
            index < 0 ||
            index >= rows.length
        ) {
            resetKeyboardFocus();
            return false;
        }

        const row =
            rows[index];

        const key =
            getStableRowKey(
                row
            );

        if (!key) {
            return false;
        }

        keyboardFocusIndex =
            index;

        keyboardFocusKey =
            key;

        setKeyboardFocusVisual(
            row
        );


        console.log(
            'ONET DELETE 4.8.22: aktywny mail ->',
            key
        );


        return true;
    }


    function findIndexByStableKey(
        rows,
        key
    ) {
        if (!key) {
            return -1;
        }

        return rows.findIndex(
            row =>
                getStableRowKey(
                    row
                ) === key
        );
    }


    async function setExactSelectionRange(
        rows,
        anchorIndex,
        focusIndex
    ) {
        if (
            anchorIndex < 0 ||
            focusIndex < 0 ||
            anchorIndex >= rows.length ||
            focusIndex >= rows.length
        ) {
            return false;
        }

        const start =
            Math.min(
                anchorIndex,
                focusIndex
            );

        const end =
            Math.max(
                anchorIndex,
                focusIndex
            );


        /*
         * Shift+Arrow tworzy dokładnie jeden ciągły zakres.
         * Maile poza zakresem są odznaczane, a maile w zakresie zaznaczane.
         *
         * Po każdym kliknięciu pobieramy świeży DOM, bo Onet/React
         * może przebudować listę.
         */
        const desiredKeys =
            new Set(
                rows
                    .slice(
                        start,
                        end + 1
                    )
                    .map(
                        getStableRowKey
                    )
                    .filter(
                        Boolean
                    )
            );


        for (
            let guard = 0;
            guard < rows.length + 5;
            guard++
        ) {
            const freshRows =
                getNavigableMailRows();

            let changed =
                false;


            for (
                const row
                of freshRows
            ) {
                const key =
                    getStableRowKey(
                        row
                    );

                if (!key) {
                    continue;
                }

                const shouldSelect =
                    desiredKeys.has(
                        key
                    );

                const isSelected =
                    row.classList
                        .contains(
                            'is-checked'
                        );


                if (
                    shouldSelect ===
                    isSelected
                ) {
                    continue;
                }


                const button =
                    await resolveRowCheckboxButton(
                        row
                    );


                if (!button) {
                    return false;
                }


                try {
                    clickOnetControl(
                        button
                    );
                } catch {
                    return false;
                }


                changed =
                    true;


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            45
                        )
                );


                /*
                 * Po jednym kliknięciu od razu wracamy do zewnętrznej
                 * pętli po świeży DOM.
                 */
                break;
            }


            if (!changed) {
                return true;
            }
        }


        return false;
    }


    function handleManualSelectionClick(
        event
    ) {
        /*
         * Bardzo ważne:
         * kliknięcia checkboxów generowane przez Spację / Shift+strzałki
         * też przechodzą przez event "click". Nie mogą być traktowane
         * jako ręczne kliknięcia użytkownika, bo wtedy każdy kolejny
         * zaznaczany mail przesuwał anchor Shift i zakres zapadał się
         * do dwóch wiadomości.
         */
        if (
            keyboardNavigationBusy
        ) {
            return;
        }


        const target =
            event.target;


        if (
            !target ||
            target.nodeType !==
                1
        ) {
            return;
        }


        const row =
            target.closest?.(
                'li.list-item'
            );


        if (!row) {
            return;
        }


        const checkbox =
            findRowCheckboxButton(
                row
            );


        if (
            !checkbox ||
            !(
                target ===
                    checkbox ||
                checkbox.contains(
                    target
                )
            )
        ) {
            return;
        }


        const key =
            getStableRowKey(
                row
            );


        if (!key) {
            return;
        }


        /*
         * Kliknięcie jest obsługiwane przez Reacta, więc czekamy,
         * aż Onet zaktualizuje klasę is-checked / ewentualnie przebuduje DOM.
         */
        setTimeout(
            () => {
                const rows =
                    getNavigableMailRows();

                const freshIndex =
                    findIndexByStableKey(
                        rows,
                        key
                    );


                if (
                    freshIndex <
                    0
                ) {
                    return;
                }


                const freshRow =
                    rows[
                        freshIndex
                    ];


                /*
                 * Jeśli po kliknięciu mail jest zaznaczony,
                 * staje się też aktywnym mailem dla strzałek i klawisza S.
                 */
                if (
                    freshRow.classList
                        .contains(
                            'is-checked'
                        )
                ) {
                    keyboardFocusIndex =
                        freshIndex;

                    keyboardFocusKey =
                        key;

                    keyboardShiftAnchorKey =
                        key;

                    setKeyboardFocusVisual(
                        freshRow
                    );


                    console.log(
                        'ONET DELETE 4.8.22: ręcznie zaznaczony mail -> fokus',
                        key
                    );

                    return;
                }


                /*
                 * v4.8.18:
                 * Odznaczenie checkboxa NIE kasuje aktywnego fokusu.
                 *
                 * Jeśli użytkownik był na tym mailu, odznaczył go i potem
                 * naciska strzałkę, nawigacja ma iść do sąsiedniego maila,
                 * a nie zaczynać ponownie od początku listy.
                 */
                if (
                    keyboardFocusKey ===
                        key
                ) {
                    keyboardFocusIndex =
                        freshIndex;

                    keyboardFocusKey =
                        key;

                    keyboardShiftAnchorKey =
                        key;

                    setKeyboardFocusVisual(
                        freshRow
                    );


                    console.log(
                        'ONET DELETE 4.8.22: ręcznie odznaczony mail -> fokus pozostaje',
                        key
                    );
                }
            },
            90
        );
    }


    async function handleArrowNavigation(
        event
    ) {
        const isDown =
            event.key ===
                'ArrowDown' ||
            event.code ===
                'ArrowDown';

        const isUp =
            event.key ===
                'ArrowUp' ||
            event.code ===
                'ArrowUp';

        if (
            !isDown &&
            !isUp
        ) {
            return;
        }

        if (
            isTyping(
                event
            ) ||
            keyboardNavigationBusy
        ) {
            return;
        }

        if (
            getConfirmationButton(
                'cancel'
            )
        ) {
            return;
        }

        const rows =
            getNavigableMailRows();

        if (
            rows.length ===
                0
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        keyboardNavigationBusy =
            true;

        try {
            const synced =
                syncKeyboardFocusToFreshDom();


            /*
             * Brak aktywnego maila:
             * ↓ -> pierwszy
             * ↑ -> ostatni
             *
             * Samo wejście do listy nie zaznacza checkboxa.
             */
            if (
                synced.index ===
                    null
            ) {
                const manuallySelected =
                    rows.filter(
                        row =>
                            row.classList
                                .contains(
                                    'is-checked'
                                )
                    );


                /*
                 * Gdy mail został zaznaczony myszą zanim istniał fokus
                 * klawiaturowy, strzałki zaczynają od tego zaznaczenia,
                 * a nie od pierwszego/ostatniego maila.
                 */
                if (
                    manuallySelected.length >
                    0
                ) {
                    const row =
                        manuallySelected[
                            manuallySelected.length - 1
                        ];

                    const index =
                        rows.indexOf(
                            row
                        );


                    if (
                        index >=
                        0
                    ) {
                        focusMailAtIndex(
                            rows,
                            index
                        );

                        keyboardShiftAnchorKey =
                            getStableRowKey(
                                row
                            );


                        /*
                         * To samo naciśnięcie strzałki ma od razu przejść
                         * do sąsiedniego maila.
                         */
                        const nextFromManual =
                            index +
                            (
                                isDown
                                    ? 1
                                    : -1
                            );


                        if (
                            nextFromManual <
                                0 ||
                            nextFromManual >=
                                rows.length
                        ) {
                            resetKeyboardFocus();

                        } else {
                            focusMailAtIndex(
                                rows,
                                nextFromManual
                            );
                        }


                        return;
                    }
                }


                focusMailAtIndex(
                    rows,
                    isDown
                        ? 0
                        : rows.length - 1
                );

                keyboardShiftAnchorKey =
                    null;

                return;
            }


            const nextIndex =
                synced.index +
                (
                    isDown
                        ? 1
                        : -1
                );


            /*
             * Wyjście poza listę:
             * normalna strzałka kasuje tylko aktywny fokus.
             *
             * Przy Shifcie zostawiamy istniejący zakres i nie wychodzimy
             * poza listę.
             */
            if (
                nextIndex < 0 ||
                nextIndex >=
                    rows.length
            ) {
                if (
                    !event.shiftKey
                ) {
                    resetKeyboardFocus();
                }

                return;
            }


            if (
                event.shiftKey
            ) {
                /*
                 * Anchor pozostaje stały przez całą serię Shift+Arrow.
                 * Programowe kliknięcia checkboxów są ignorowane przez
                 * handleManualSelectionClick, więc nie przesuwają anchor.
                 *
                 * Pierwszy Shift+Arrow zakotwicza zakres na aktualnym mailu.
                 * Jeśli wcześniej Spacją zaznaczono aktywny mail, anchor też
                 * jest już ustawiony na nim.
                 */
                if (
                    !keyboardShiftAnchorKey
                ) {
                    keyboardShiftAnchorKey =
                        keyboardFocusKey;
                }


                const freshRows =
                    getNavigableMailRows();

                const anchorIndex =
                    findIndexByStableKey(
                        freshRows,
                        keyboardShiftAnchorKey
                    );


                if (
                    anchorIndex <
                    0
                ) {
                    keyboardShiftAnchorKey =
                        keyboardFocusKey;
                }


                const finalAnchorIndex =
                    findIndexByStableKey(
                        freshRows,
                        keyboardShiftAnchorKey
                    );


                const nextKey =
                    getStableRowKey(
                        freshRows[
                            nextIndex
                        ]
                    );


                if (
                    finalAnchorIndex <
                        0 ||
                    !nextKey
                ) {
                    return;
                }


                const ok =
                    await setExactSelectionRange(
                        freshRows,
                        finalAnchorIndex,
                        nextIndex
                    );


                if (!ok) {
                    return;
                }


                /*
                 * Po zaznaczeniu zakresu React mógł przebudować DOM.
                 * Fokus ustawiamy ponownie po stabilnym ID.
                 */
                const newestRows =
                    getNavigableMailRows();

                const newestIndex =
                    findIndexByStableKey(
                        newestRows,
                        nextKey
                    );


                if (
                    newestIndex >=
                    0
                ) {
                    focusMailAtIndex(
                        newestRows,
                        newestIndex
                    );
                }


            } else {
                /*
                 * Zwykłe strzałki zmieniają wyłącznie aktywny mail.
                 * Nie zmieniają checkboxów.
                 *
                 * Rozpoczynając zwykłą nawigację kończymy poprzedni
                 * Shift-range; następny Shift zacznie nowy zakres od
                 * aktualnego maila.
                 */
                keyboardShiftAnchorKey =
                    null;


                focusMailAtIndex(
                    rows,
                    nextIndex
                );
            }


        } finally {
            keyboardNavigationBusy =
                false;
        }
    }


    async function handleSpaceSelection(
        event
    ) {
        const isSpace =
            event.key ===
                ' ' ||
            event.key ===
                'Spacebar' ||
            event.code ===
                'Space';

        if (!isSpace) {
            return;
        }

        if (
            isTyping(
                event
            ) ||
            keyboardNavigationBusy
        ) {
            return;
        }

        if (
            getConfirmationButton(
                'cancel'
            )
        ) {
            return;
        }


        /*
         * Jeśli zaznaczonych jest wiele wiadomości, Spacja ma specjalne
         * znaczenie: odznacza CAŁĄ aktualną selekcję naraz.
         *
         * Działa również wtedy, gdy fokus klawiaturowy nie jest ustawiony.
         */
        const selectedRows =
            getSelectedMailRows();


        if (
            selectedRows.length >
                1
        ) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();


            const cleared =
                deselectSelectedEmails();


            if (
                cleared
            ) {
                /*
                 * Zachowujemy aktywny mail/fokus strzałek, ale resetujemy
                 * anchor zakresu Shift, bo po wyczyszczeniu nie ma już
                 * istniejącego zakresu zaznaczenia.
                 */
                keyboardShiftAnchorKey =
                    null;


                console.log(
                    `ONET DELETE 4.8.22: Spacja -> odznaczono wszystkie (${selectedRows.length})`
                );


                /*
                 * React może odświeżyć DOM po kliknięciu checkboxów.
                 * Po chwili przywracamy wizualny fokus po stabilnym ID.
                 */
                setTimeout(
                    syncKeyboardFocusToFreshDom,
                    100
                );
            }


            return;
        }


        const synced =
            syncKeyboardFocusToFreshDom();

        if (
            synced.index ===
                null ||
            !synced.row
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        keyboardNavigationBusy =
            true;

        try {
            const row =
                synced.row;

            const key =
                getStableRowKey(
                    row
                );

            const wasSelected =
                row.classList
                    .contains(
                        'is-checked'
                    );

            const button =
                await resolveRowCheckboxButton(
                    row
                );

            if (!button) {
                console.log(
                    'ONET DELETE 4.8.22: Spacja -> nie znaleziono checkboxa nawet po hover',
                    key
                );
                return;
            }

            clickOnetControl(
                button
            );


            /*
             * Po Spacji aktualny mail staje się naturalnym punktem
             * zakotwiczenia dla późniejszego Shift+Arrow.
             */
            keyboardShiftAnchorKey =
                keyboardFocusKey;


            /*
             * Czekamy na rzeczywistą zmianę is-checked w świeżym DOM.
             */
            const started =
                Date.now();

            let changed =
                false;

            while (
                Date.now() -
                    started <
                    1500
            ) {
                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            40
                        )
                );

                const fresh =
                    syncKeyboardFocusToFreshDom();

                if (
                    fresh.row &&
                    fresh.row.classList
                        .contains(
                            'is-checked'
                        ) !==
                        wasSelected
                ) {
                    changed =
                        true;
                    break;
                }
            }

            console.log(
                'ONET DELETE 4.8.22: Spacja ->',
                changed
                    ? (
                        wasSelected
                            ? 'odznaczono'
                            : 'zaznaczono'
                    )
                    : 'brak zmiany',
                key
            );

        } catch (
            error
        ) {
            console.error(
                'ONET DELETE 4.8.22: błąd Space',
                error
            );

        } finally {
            keyboardNavigationBusy =
                false;
        }
    }



    // ============================================================
    // S = GWIAZDKA / ULUBIONE
    // ============================================================

    function findRowStarButton(
        row
    ) {
        if (!row) {
            return null;
        }


        const main =
            row.querySelector(
                ':scope > div[role="button"]'
            );


        if (!main) {
            return null;
        }


        const cells =
            [
                ...main.children
            ];


        const firstCell =
            cells[0] ||
            null;


        /*
         * Najpierw strukturalnie: gwiazdka jest w drugiej komórce.
         * To jest odporne na przypadek, gdy pierwsza komórka pokazuje
         * ikonę nadawcy zamiast checkboxa.
         */
        if (
            cells.length >=
                2
        ) {
            const candidates =
                [
                    ...cells[1].querySelectorAll(
                        'button[type="button"], button'
                    )
                ];


            if (
                candidates.length >
                0
            ) {
                return candidates[0];
            }
        }


        /*
         * Fallback po etykiecie, ale WYKLUCZAMY przyciski z pierwszej
         * komórki, bo tam może istnieć ukryty checkbox.
         */
        const labelled =
            [
                ...row.querySelectorAll(
                    [
                        'button[type="button"][title="Oznacz wiadomość"]',
                        'button[type="button"][title="Odznacz wiadomość"]',
                        'button[type="button"][aria-label="Oznacz wiadomość"]',
                        'button[type="button"][aria-label="Odznacz wiadomość"]'
                    ].join(',')
                )
            ];


        const outsideFirstCell =
            labelled.find(
                button =>
                    !firstCell ||
                    !firstCell.contains(
                        button
                    )
            );


        return (
            outsideFirstCell ||
            null
        );
    }


        function parseCssRgb(
        value
    ) {
        if (
            !value ||
            value ===
                'transparent'
        ) {
            return null;
        }


        const match =
            String(
                value
            )
                .match(
                    /rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i
                );


        if (!match) {
            return null;
        }


        return {
            r:
                Number(
                    match[1]
                ),

            g:
                Number(
                    match[2]
                ),

            b:
                Number(
                    match[3]
                )
        };
    }


    function isGoldStarColor(
        color
    ) {
        if (!color) {
            return false;
        }


        return (
            color.r >=
                180 &&
            color.g >=
                130 &&
            color.b <=
                120 &&
            color.r >
                color.b *
                1.5
        );
    }


    function isRowStarred(
        row
    ) {
        const button =
            findRowStarButton(
                row
            );


        if (!button) {
            return false;
        }


        /*
         * Potwierdzone w rzeczywistym DOM Onet Poczta:
         *
         * brak gwiazdki:
         *   title="Oznacz wiadomość"
         *
         * gwiazdka ustawiona:
         *   title="Usuń oznaczenie"
         *
         * Nie używamy już heurystyk kolorów ani innych przybliżeń.
         */
        const title =
            (
                button.getAttribute(
                    'title'
                ) ||
                ''
            )
                .trim()
                .toLocaleLowerCase(
                    'pl-PL'
                );


        return (
            title ===
                'usuń oznaczenie'
        );
    }

        async function setUniformStarStateForSelectedRows(
        rows
    ) {
        if (
            !Array.isArray(
                rows
            ) ||
            rows.length ===
                0
        ) {
            return {
                changed:
                    0,

                targetStarred:
                    true
            };
        }


        /*
         * Najpierw ustalamy stan całej grupy.
         *
         * Reguła "uniform":
         * - jeśli WSZYSTKIE już mają gwiazdkę -> S usuwa gwiazdkę wszystkim,
         * - jeśli choć jeden jej nie ma       -> S nadaje gwiazdkę wszystkim.
         *
         * Dzięki temu stan mieszany nigdy nie zostanie odwrócony 1:1.
         */
        const currentStates =
            rows.map(
                row =>
                    isRowStarred(
                        row
                    )
            );


        const allStarred =
            currentStates.every(
                Boolean
            );


        const targetStarred =
            !allStarred;


        let changed =
            0;


        const keys =
            rows
                .map(
                    getStableRowKey
                )
                .filter(
                    Boolean
                );


        for (
            const key
            of keys
        ) {
            /*
             * Po każdej zmianie Onet/React może przebudować DOM,
             * dlatego zawsze pobieramy świeży wiersz po stabilnym ID.
             */
            const freshRows =
                getNavigableMailRows();


            const row =
                freshRows.find(
                    item =>
                        getStableRowKey(
                            item
                        ) ===
                        key
                );


            if (!row) {
                continue;
            }


            const starredNow =
                isRowStarred(
                    row
                );


            if (
                starredNow ===
                    targetStarred
            ) {
                continue;
            }


            const button =
                findRowStarButton(
                    row
                );


            if (!button) {
                continue;
            }


            try {
                if (
                    typeof clickOnetControl ===
                        'function'
                ) {
                    clickOnetControl(
                        button
                    );

                } else {
                    button.click();
                }


                changed++;


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            80
                        )
                );


            } catch {}
        }


        return {
            changed,
            targetStarred
        };
    }

    async function handleStarShortcut(
        event
    ) {
        const isStarShortcut =
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.shiftKey &&
            (
                event.key ===
                    's' ||
                event.key ===
                    'S' ||
                event.code ===
                    'KeyS'
            );


        if (!isStarShortcut) {
            return;
        }


        if (
            isTyping(
                event
            )
        ) {
            return;
        }


        if (
            getConfirmationButton(
                'cancel'
            )
        ) {
            return;
        }


        const selectedRows =
            getSelectedMailRows();


        /*
         * REGUŁA:
         * - jeśli zaznaczonych jest WIĘCEJ NIŻ 1 mail -> S oznacza gwiazdką
         *   wszystkie zaznaczone;
         * - jeśli zaznaczonych jest 0 lub 1 -> S działa ZAWSZE na mailu
         *   aktualnie wskazanym fokusem klawiaturowym (obwódka).
         *
         * To eliminuje bug, w którym pojedynczy, wcześniej checkboxowo
         * zaznaczony mail "przejmował" klawisz S mimo przesunięcia fokusu
         * strzałkami na inny wiersz.
         */
        if (
            selectedRows.length >
                1
        ) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();


            const result =
                await setUniformStarStateForSelectedRows(
                    selectedRows
                );


            console.log(
                `ONET POST COMPANION: S -> ${result.targetStarred ? 'ustawiono' : 'usunięto'} gwiazdkę uniform dla ${selectedRows.length} zaznaczonych; zmieniono ${result.changed}`
            );


            setTimeout(
                syncKeyboardFocusToFreshDom,
                100
            );


            return;
        }


        /*
         * Dla 0/1 zaznaczonego maila bierzemy WYŁĄCZNIE aktywny fokus
         * klawiaturowy, niezależnie od checkboxowego zaznaczenia.
         */
        const synced =
            syncKeyboardFocusToFreshDom();


        if (
            synced.index ===
                null ||
            !synced.row
        ) {
            return;
        }


        const targetRow =
            synced.row;


        const starButton =
            findRowStarButton(
                targetRow
            );


        if (!starButton) {
            console.log(
                'ONET POST COMPANION: S -> nie znaleziono przycisku gwiazdki',
                getStableRowKey(
                    targetRow
                )
            );

            return;
        }


        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();


        try {
            if (
                typeof clickOnetControl ===
                    'function'
            ) {
                clickOnetControl(
                    starButton
                );
            } else {
                starButton.click();
            }


            console.log(
                'ONET POST COMPANION: S -> przełączam gwiazdkę aktywnego maila',
                getStableRowKey(
                    targetRow
                )
            );


            setTimeout(
                syncKeyboardFocusToFreshDom,
                100
            );


        } catch (
            error
        ) {
            console.error(
                'ONET POST COMPANION: błąd przełączania gwiazdki',
                error
            );
        }
    }

    // ============================================================
    // WIELOKROTNE USUWANIE — BEZPOŚREDNI PATCH API
    // ============================================================

    function getMailIdFromSelectedRow(
        row
    ) {
        if (!row?.id) {
            return null;
        }

        const match =
            row.id.match(
                /(?:MailItem_|m_)(\d+)$/
            );

        if (!match) {
            return null;
        }

        const mid =
            Number(
                match[1]
            );

        return Number.isSafeInteger(
            mid
        )
            ? mid
            : null;
    }


    function buildBulkDeleteSourceGroups(
        rows
    ) {
        const srcMails =
            {};


        for (
            const row
            of rows
        ) {
            const mid =
                getMailIdFromSelectedRow(
                    row
                );

            if (
                !Number.isSafeInteger(
                    mid
                )
            ) {
                return null;
            }


            const fid =
                mailFolderByMid.get(
                    mid
                );


            if (
                !Number.isSafeInteger(
                    fid
                )
            ) {
                return null;
            }


            if (
                !srcMails[
                    fid
                ]
            ) {
                srcMails[
                    fid
                ] =
                    [];
            }


            srcMails[
                fid
            ].push(
                mid
            );
        }


        return srcMails;
    }


    async function deleteSelectedMailsByApi(
        rows
    ) {
        if (
            bulkDeleteInProgress ||
            !Array.isArray(
                rows
            ) ||
            rows.length <
                2
        ) {
            return false;
        }


        const trashId =
            await ensureTrashFolderId();


        const srcMails =
            buildBulkDeleteSourceGroups(
                rows
            );


        if (
            !srcMails ||
            Object.keys(
                srcMails
            ).length ===
                0
        ) {
            console.log(
                'ONET DELETE 4.8.22: brak pełnych danych fid/mid; używam natywnego Usuń'
            );

            return false;
        }


        /*
         * W Koszu i SPAM-ie nie robimy automatycznego PATCH-a,
         * ponieważ tam usunięcie może być trwałe i wymagać modala.
         */
        const sourceFolderIds =
            Object.keys(
                srcMails
            )
                .map(
                    Number
                );


        if (
            sourceFolderIds.some(
                fid =>
                    fid ===
                    trashId
            )
        ) {
            return false;
        }


        const payload = {
            dstFolder:
                trashId,

            srcMails
        };


        bulkDeleteInProgress =
            true;


        try {
            console.log(
                `ONET DELETE 4.8.22: usuwam ${rows.length} zaznaczonych maili jednym PATCH-em`,
                payload
            );


            await sendMovePatch(
                payload
            );


            /*
             * sendMovePatch jest żądaniem wewnętrznym, więc ręcznie
             * dodajemy operację do wielopoziomowego Ctrl+Z/Ctrl+Y.
             */
            const inverseRequests =
                buildInverseRequests(
                    payload
                );


            if (
                inverseRequests.length >
                0
            ) {
                pushUndoState({
                    createdAt:
                        Date.now(),

                    originalPayload:
                        payload,

                    inverseRequests
                });

                clearRedoStack();
            }


            showUndoNotice(
                `Usunięto ${rows.length} wiadomości.`
            );


            /*
             * v4.8.12:
             * Po zwykłym Delete/Backspace NIE robimy pełnego reloadu.
             * Backend już przyjął PATCH; zostawiamy stronę bez przeładowania.
             *
             * Ctrl+Z / Ctrl+Y zachowują własny reload, bo tam odwracamy
             * stan poza normalną akcją UI i chcemy wymusić synchronizację.
             */
            return true;

        } catch (
            error
        ) {
            console.error(
                'ONET DELETE 4.8.22: wielokrotne usuwanie nie powiodło się',
                error
            );

            return false;

        } finally {
            bulkDeleteInProgress =
                false;
        }
    }


    // ============================================================
    // SZUKANIE "USUŃ" — LOGIKA ZE STABILNEJ WERSJI 2.6
    // ============================================================

    function findDeleteButton() {
        const doc =
            getMainDocument();

        const directSelectors = [
            'button[aria-label="Usuń"]',
            '[role="button"][aria-label="Usuń"]',
            'button[title="Usuń"]',
            '[role="button"][title="Usuń"]',
            'button[aria-label="Usuń wiadomość"]',
            '[role="button"][aria-label="Usuń wiadomość"]',
            'button[title="Usuń wiadomość"]',
            '[role="button"][title="Usuń wiadomość"]'
        ];


        for (
            const selector
            of directSelectors
        ) {
            const candidates =
                [
                    ...doc.querySelectorAll(
                        selector
                    )
                ];

            const visible =
                candidates.find(
                    isVisible
                );

            if (visible) {
                return visible;
            }
        }


        const elements =
            [
                ...doc.querySelectorAll(
                    'button, [role="button"], a, div, span'
                )
            ];

        const candidates = [];


        for (const el of elements) {
            if (!isVisible(el)) {
                continue;
            }

            const text =
                cleanText(
                    el.innerText ||
                    el.textContent
                );

            const aria =
                cleanText(
                    el.getAttribute(
                        'aria-label'
                    )
                );

            const title =
                cleanText(
                    el.getAttribute(
                        'title'
                    )
                );

            const matches =
                (
                    text === 'Usuń' ||
                    aria === 'Usuń' ||
                    title === 'Usuń' ||
                    aria === 'Usuń wiadomość' ||
                    title === 'Usuń wiadomość'
                );

            if (!matches) {
                continue;
            }

            const clickable =
                el.closest(
                    'button, [role="button"], a'
                )
                ||
                el;

            if (!isVisible(clickable)) {
                continue;
            }

            const rect =
                clickable
                    .getBoundingClientRect();

            let score = 0;

            if (
                clickable.tagName ===
                'BUTTON'
            ) {
                score += 100;
            }

            if (
                clickable.getAttribute(
                    'role'
                ) === 'button'
            ) {
                score += 60;
            }

            if (
                aria === 'Usuń' ||
                title === 'Usuń'
            ) {
                score += 40;
            }

            score -=
                rect.top / 100;

            candidates.push({
                el: clickable,
                score
            });
        }


        candidates.sort(
            (a, b) =>
                b.score - a.score
        );


        return (
            candidates[0]?.el ||
            null
        );
    }


    // ============================================================
    // DELETE / BACKSPACE
    // ============================================================

    async function deleteCurrentMail(event) {
        if (
            event.key !== 'Delete' &&
            event.key !== 'Backspace'
        ) {
            return;
        }


        if (
            isTyping(event)
        ) {
            return;
        }


        const selectedRows =
            getSelectedMailRows();


        /*
         * Jeśli zaznaczono co najmniej dwa maile, nie klikamy toolbaru.
         * Wysyłamy jeden bezpośredni PATCH API obejmujący wszystkie
         * zaznaczone wiadomości.
         */
        if (
            selectedRows.length >=
            2
        ) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();


            const handled =
                await deleteSelectedMailsByApi(
                    selectedRows
                );


            if (handled) {
                return;
            }


            /*
             * Jeśli nie mamy jeszcze cache fid/mid, spadamy do natywnego
             * przycisku Usuń Onetu zamiast niczego nie robić.
             */
        }


        const deleteButton =
            findDeleteButton();


        if (!deleteButton) {
            return;
        }


        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();


        console.log(
            'ONET DELETE 4.8.22: usuwam wiadomość przez natywne Usuń',
            deleteButton
        );


        deleteButton.click();

        watchForConfirmationBriefly();
    }


    // ============================================================
    // LISTENERY
    // ============================================================

    const installedDocuments =
        new WeakSet();


    function installOnDocument(doc) {
        if (
            !doc ||
            installedDocuments.has(doc)
        ) {
            return;
        }

        installedDocuments.add(doc);


        /*
         * Kolejność:
         *
         * 1. Ctrl+Z = cofnij ostatnie przeniesienie / usunięcie
         * 2. Ctrl+Y = ponów ostatnio cofnięte przeniesienie
         * 3. modal: Enter=Tak / Esc=Anuluj
         * 4. Esc poza modalem: odznacz zaznaczone maile
         * 5. Delete/Backspace: usuń
         */

        doc.addEventListener(
            'click',
            handleManualSelectionClick,
            true
        );


        doc.addEventListener(
            'keydown',
            handleUndoShortcut,
            true
        );

        doc.addEventListener(
            'keydown',
            handleRedoShortcut,
            true
        );

        doc.addEventListener(
            'keydown',
            handleConfirmationKeys,
            true
        );

        doc.addEventListener(
            'keydown',
            handleEscapeDeselect,
            true
        );

        doc.addEventListener(
            'keydown',
            handleArrowNavigation,
            true
        );


        doc.addEventListener(
            'keydown',
            handleSpaceSelection,
            true
        );


        doc.addEventListener(
            'keydown',
            handleStarShortcut,
            true
        );


        doc.addEventListener(
            'keydown',
            deleteCurrentMail,
            true
        );

        scanFrames(doc);

        console.log(
            'ONET DELETE 4.8.22: listenery założone',
            doc
        );
    }


    // ============================================================
    // IFRAMES
    // ============================================================

    function attachFrame(iframe) {
        function tryAttach() {
            try {
                const frameDoc =
                    iframe.contentDocument;

                if (frameDoc) {
                    installOnDocument(
                        frameDoc
                    );
                }
            } catch {}
        }

        tryAttach();

        iframe.addEventListener(
            'load',
            tryAttach
        );
    }


    function scanFrames(doc) {
        for (
            const iframe
            of doc.querySelectorAll(
                'iframe'
            )
        ) {
            attachFrame(iframe);
        }
    }


    // ============================================================
    // SPA
    // ============================================================

    const mainDocument =
        getMainDocument();

    /*
     * Historia stosów przeżywa reload bieżącej karty dzięki sessionStorage.
     */
    loadHistoryStacks();

    /*
     * Reklama cofnięta Ctrl+Z nie powinna zostać automatycznie usunięta
     * ponownie w tej samej sesji.
     */
    loadAutoAdHandledIds();

    /*
     * Musi być aktywne zanim użytkownik pierwszy raz naciśnie Delete
     * albo użyje "Przenieś".
     * @grant none sprawia, że patchujemy ten sam window.fetch,
     * którego używa aplikacja Onet Poczta.
     */
    installFetchInterceptor();

    installOnDocument(
        mainDocument
    );


    const observer =
        new MutationObserver(
            mutations => {
                for (
                    const mutation
                    of mutations
                ) {
                    for (
                        const node
                        of mutation.addedNodes
                    ) {
                        if (
                            !node ||
                            node.nodeType !== 1
                        ) {
                            continue;
                        }

                        if (
                            node.tagName ===
                            'IFRAME'
                        ) {
                            attachFrame(
                                node
                            );
                        }

                        for (
                            const iframe
                            of node.querySelectorAll?.(
                                'iframe'
                            ) || []
                        ) {
                            attachFrame(
                                iframe
                            );
                        }
                    }
                }
            }
        );


    observer.observe(
        mainDocument.documentElement,
        {
            childList: true,
            subtree: true
        }
    );

})();
