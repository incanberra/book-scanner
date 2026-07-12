# TODOS

## QA

### Run a genuine Android disaster-recovery drill

**What:** Export the catalogue from the installed Android PWA, retain the file outside browser storage, clear Book Scanner site data or uninstall it, reinstall or reopen the PWA, and restore through Android's file picker.

**Why:** Automated codec and empty-database tests cannot prove that a downloaded backup survives browser-data loss or that Android can select and restore it afterward.

**Context:** Version one requires automated export/import, validation, transaction rollback, and ordinary target-phone round-trip tests. During the engineering review, the destructive real-device drill was explicitly deferred so it would not gate the first release. Use expendable test books and verify an exact restored catalogue before trusting the result.

**Effort:** S
**Priority:** P2
**Depends on:** A deployed Android-installable PWA containing expendable test books

## Completed
