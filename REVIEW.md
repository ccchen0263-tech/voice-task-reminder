# voice-task-reminder review

## Source and handoff

- Source repo: `https://github.com/ccchen0263-tech/voice-task-reminder.git`
- Source branch / commit: `main` / `749103ec59385493e87c1b9b48b2bccc00e5ad44`
- Work copy: this directory; changes are uncommitted and isolated.
- The Vercel project remains the existing deployment target. No push, deploy, OAuth, API key, calendar event, or private-data upload was performed.

## Review conclusions

- Legacy task records remain readable and are normalized non-destructively with personal-mode defaults and optional location/attachment metadata. Existing data is not rewritten on load.
- Attachment blobs are local IndexedDB only. A failed write rolls back any partial blob writes and leaves no task success state. The task is committed only after all blobs succeed and task metadata saves successfully.
- Allowed attachments are images, PDF, TXT, CSV, Word, and Excel. HTML, SVG, executable types, and oversized files are rejected; unsafe filename characters are sanitized. Images use local Blob URL preview; other files are download-only and are never executed in the page.
- Deleted task attachments remain locally recoverable during the 15-second undo window; the settings panel also provides an explicit local “清理未連結附件” action. Clearing site data removes local tasks, settings, and attachments.
- JSON export contains task data and attachment metadata only. There is no JSON import, so the backup cannot overwrite existing data and cannot be mistaken for an attachment backup.
- Time parsing and classification preserve existing timezone behavior, including due/today/pending boundaries and UTC calendar export. Map links are generated only with `https:` and the fixed `www.google.com` host. Missing, empty, non-finite, and out-of-range coordinates fall back to the entered address; true numeric or string `0,0` coordinates remain valid.
- Calendar settings are local preferences. Google remains a `TEMPLATE` draft URL, Apple remains an `.ics` file download; no real `calendarId` binding or successful remote save is claimed.

## Validation

- `npm test`: 60 passed, 0 failed, including regression coverage for null/undefined/empty/out-of-range map coordinates and valid `0,0` coordinates.
- `npm run build`: passed; 8 static assets generated.
- `node --check` for changed JavaScript: passed.
- `git diff --check`: passed.
- Local HTTP smoke: `/`, existing assets, and new JS assets returned 200; unknown route returned 404.
- Browser/mobile UI, microphone, geolocation permission, IndexedDB quota behavior, and real-device background delivery remain unverified because the built-in computer tool failed with `HRESULT 0x80070003`, no browser executable was available at known paths, and Playwright CLI could not start without downloading dependencies.

## Handoff artifacts

- `voice-task-reminder-handoff.patch` and `voice-task-reminder-handoff.zip` are generated beside the work copy; final SHA-256 values are reported with delivery.
- `voice-task-reminder-backup.bundle` — SHA-256 `91934827157B4E9AD9F3E243BCAF908124958CB6CFCB9C7B662100217036C391`

## Changed files

`index.html`, `styles.css`, `server.js`, `使用說明.md`, `js/app.js`, `js/calendar.js`, `js/task-store.js`, `js/settings-store.js`, `js/attachment-store.js`, `tests/app-speech.test.js`, `tests/calendar.test.js`, `tests/task-store.test.js`, `tests/settings-store.test.js`, `tests/attachment-store.test.js`.
