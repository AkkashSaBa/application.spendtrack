# SpendPulse — Product Requirements

## Problem statement
Build a mobile app from the supplied Akash Spends concept, updated into a spending dashboard with charts, categories, and monthly summaries.

## Architecture
- Expo SDK 54 React Native frontend with Expo Router.
- FastAPI backend on port 8001 with MongoDB persistence.
- REST endpoints under `/api/transactions` for list, create, update, and delete.

## User personas
- Individuals who want a calm, quick view of monthly spending.
- Users who need lightweight category and cash-flow visibility without a full banking connection.

## Core requirements (static)
- Show running balance, income, spending, savings, and recent transactions.
- Support expense and income entry with category, amount, date, and optional note.
- Provide category bars, cash-flow comparison, analytics, and category views.
- Persist transactions in MongoDB and keep mobile controls touch-friendly.

## Implemented
- 2026-08-22: Replaced starter image screen with SpendPulse dashboard using the botanical palette and native navigation.
- 2026-08-22: Added Mongo-backed transaction CRUD APIs with valid calendar-date validation.
- 2026-08-22: Added overview, analytics, categories, monthly summary cards, empty states, and add-transaction bottom sheet.
- 2026-08-22: Verified API CRUD and Expo phone preview; added stable testIDs for key controls.
- 2026-08-22: Added email/password sign-up, login, secure session restore, logout revocation, and private per-user transaction queries.
- 2026-08-22: Added keyboard-aware transaction entry scrolling and authenticated regression coverage.
- 2026-08-22: Added monthly per-category budgets (`/api/budgets` GET/PUT/DELETE), progress bars with warning/over-budget colors, and a top-of-screen alert when spending exceeds any limit.
- 2026-08-22: Switched login to username-based auth (email still collected at signup for recovery). Added forgot-password + reset flow using Emergent-managed Resend to email a single-use 30-minute reset code. Existing users migrated automatically.
- 2026-08-22: Added long-press → Edit / Delete on any recent transaction row. Edit reuses the transaction editor (pre-filled, calls PUT). Delete opens a custom Confirm sheet (works on native + web preview) and calls DELETE. Forgot Password sheet now shows a spam-folder hint.
- 2026-08-22: Renamed transaction types to Transferred / Received (UI only; DB stays expense/income). Split categories per type: Transferred = Food/Transport/Bills/Rent/Shopping/Health/Travel/Other; Received = Salary/Interest/Trading/Other. Added month picker on Overview. Added Settings bottom sheet (avatar or bottom-nav) with Change Password, Export CSV, Log Out. Backend: POST /api/auth/change-password and GET /api/transactions/export?month=YYYY-MM.

## Prioritized backlog
- P0: None remaining for the current dashboard MVP.
- P1: Add edit/delete actions from the recent activity list; add month navigation.
- P2: Add exportable monthly reports, receipt attachments, password reset, and optional account sync.

## Next tasks
1. Add transaction edit and delete affordances.
2. Add historical month picker and budget progress per category.

## Changelog — 2026-08-23 (ported repo AkkashSaBa/Antrom into workspace)
- Add Transaction now has a third **Savings** tab alongside Transferred and Received, with its own categories (Emergency Fund, Goal, Investment, Retirement, Other) and gold styling.
- Savings is tracked separately and does **not** change the Total Balance (money set aside). The monthly summary "Savings" metric now reflects real savings entries.
- Total Balance = Received − Transferred. When Transferred exceeds Received the balance now shows a **minus sign in red** on the hero card.
- Backend: `Transaction.type` accepts `savings` in addition to `expense`/`income`.
- Env: added JWT_SECRET; EMERGENT_EMAIL_KEY left blank (forgot-password email out of scope — degrades gracefully).


## Changelog — 2026-08-23 (features)
- Fixed forgot-password: set the provisioned EMERGENT_EMAIL_KEY so reset codes actually send (email proxy returns 202). Verified 11/11.
- **Savings Goals**: new backend GET/PUT/DELETE /api/savings-goal (per-user target). Overview shows a circular progress ring (react-native-svg) of cumulative savings vs target, with set/edit/remove sheet. Ring turns green at 100%.
- **Low Balance Alert**: gentle warning card on Overview shown only when Total Balance is negative (transferred > received), explaining the shortfall.
- Verified end-to-end by testing agent (iteration 7): 11/11 backend + all frontend flows, no bugs.


## Changelog — 2026-08-23 (multi-goal savings)
- Reworked single savings goal into **multiple named goals**. Backend: /api/savings-goals CRUD (name, target, target_date, celebrated). Transactions gained optional goal_id; deleting a goal unassigns its savings transactions.
- **Multiple Goals**: Overview lists a card + progress ring per goal; Add Transaction Savings tab tags savings to a chosen goal (or General).
- **Monthly Save Nudge**: goals with a target date show "Save ₹X/mo to reach by <Mon YYYY>" (remaining ÷ months left).
- **Goal Celebration**: hitting a goal (saved ≥ target) fires a one-time confetti + badge modal (react-native-confetti-cannon); celebrated flag persisted server-side so it never repeats. Reached goals show a "Reached" badge.
- Verified by testing agent (iteration 8): 20/20 backend + all frontend flows, no blocking issues.

3. Add optional statement import after the core manual workflow is reviewed.