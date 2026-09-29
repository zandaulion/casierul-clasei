# Implementation contract

Multiple classes and schools; each class has an isolated ledger and each device has an explicit treasurer, parent or auditor permission for each authorized class. Node 24 built-in HTTP and SQLite. All money is integer bani; all UI is Romanian. Empty real database on first run (no fixtures in production). The existing prototype remains in `design/`.

## HTTP

Public server stays on `127.0.0.1:8018`. Separate admin listener `127.0.0.1:8118`; public server always returns 404 for `/api/admin` and children, even with forged admin headers. Admin listener requires constant-time `X-Admin-Token` from environment. Console's private Caddy route strips `/casierul-clasei` and proxies to 8118 with the header. Public base URL comes from environment.

`GET /api/health` public. `POST /api/auth/redeem {code,label?}` -> HttpOnly, Secure, SameSite=Lax host-only cookie, response `{device}`. `POST /api/auth/access {code}` consumes another invitation into the authenticated device without removing its existing permissions. `GET /api/auth/me` -> `{device,classrooms}`. `POST /api/auth/logout`. Device validation on every business request. `GET /api/classrooms` lists authorized classes; an owner can `POST /api/classrooms {requestId,schoolName,className,schoolYear}`. Standard seven pwa-invite-console endpoints on admin listener remain backward compatible. `GET /api/admin/invite-options` lists every active class and child. Invite creation accepts `role`, the selected class/child scope and `accessExpiresAt`.

The existing `ledger.sqlite` migrates as class `default`; existing treasurer devices become owners and retain access. Missing roles on legacy invitations and devices migrate to `treasurer`. The first treasurer on a fresh installation becomes the owner. Treasurer sessions have full access within their selected class. Auditor sessions can read that class's complete state and authorized PDFs. Parent sessions receive a server-projected state containing class totals, aggregate expenses and outgoing payments, plus only their associated child's details and transactions. Parent report access is limited to aggregate class/expense reports and that child's individual reports. Every mutation, report issuance and raw JSON export requires the treasurer role for the selected class.

Business endpoints accept `?classroom=<id>`. Omitting it selects `default` when authorized, otherwise the device's first authorized class, preserving old clients and links. The server resolves the permission before opening the ledger. A class UUID cannot be used to cross the permission boundary. Direct PDF, branding and JSON export URLs carry the same query parameter.

`GET /api/state` returns state below. `GET /api/export` downloads a JSON snapshot (business data only, no device credentials). Mutations return `{ state, transactionId? }`; errors `{error}` with appropriate HTTP status. Every business POST has `requestId` (idempotency key) and `expectedRevision`. Check idempotency before stale revision; changed payload with reused key is 409. An identical successful retry returns current state and the original transactionId without writing again. If state changed for a new request, return 409 and let user refresh/review. Financial mutations are atomic.

| Endpoint | Ledger dispatch operation | Body fields beyond requestId/expectedRevision |
| --- | --- | --- |
| POST /api/settings | settings.update | schoolName, className, schoolYear, openingBalanceMinor (opening editable only before financial transactions), schoolLogo/classLogo as resized PNG data URLs or null |
| POST /api/children | child.create | firstName, lastName |
| POST /api/children/bulk | children.create | children: [{firstName,lastName}] |
| POST /api/children/:id | child.update | firstName, lastName, active?; server adds childId from URL |
| POST /api/expenses | expense.create | title, type: fixed/split/quantity, amountMinor (per child / total / unit), participants: [{childId,quantity?}], occurredAt?, dueDate?, comment? |
| POST /api/expenses/:id | expense.update | same fields as create; server adds expenseId. Descriptive fields remain editable; formula/amount/participants require no active linked money. Existing quantities may be corrected with linked money when each revised contribution still covers the amount already paid and the expense total covers linked payouts |
| POST /api/expenses/:id/cancel | expense.cancel | comment?; server adds expenseId; only allowed when no collections or linked outgoing payment remain |
| POST /api/collections | collection.create | childId, receivedMinor, changeMinor, allocations: [{expenseId,amountMinor}], occurredAt?, comment? |
| POST /api/credit/apply | credit.apply | childId, allocations: [{expenseId,amountMinor}], occurredAt?, comment? |
| POST /api/refunds | refund.create | childId, amountMinor (from existing credit), occurredAt?, comment? |
| POST /api/payments | payment.create | amountMinor, destination, expenseId?, occurredAt?, comment? |
| POST /api/transactions/:id/reverse | transaction.reverse | comment (required); server adds transactionId; append correction, never erase financial history |

## Ledger module interface

`server/ledger.mjs` exports `class Ledger` with `constructor(dbPath)`, `getState()`, `dispatch(operation, body, actor)` -> `{state,transactionId?}`, `exportData()` -> JSON snapshot, `close()`. Actor is `{id,label}`. Errors expose `status`. `ClassroomLedgers` opens one ledger file per class; auth, the classroom catalog and permissions use a separate SQLite file.

## State

```
{
 revision: 0,
 settings: {schoolName:'',className:'',schoolYear:'',openingBalanceMinor:0,hasSchoolLogo:false,hasClassLogo:false,schoolLogoVersion:null,classLogoVersion:null},
 children: [{id,firstName,lastName,active,creditMinor,dueMinor,
   contributions:[{expenseId,title,dueDate,amountMinor,paidMinor,remainingMinor}]}],
 expenses: [{id,title,type,amountMinor,totalMinor,collectedMinor,paidOutMinor,
   occurredAt,dueDate,comment,cancelled,
   contributions:[{childId,amountMinor,quantity}]}],
 transactions: [{id,type,occurredAt,createdAt,childId,expenseId,destination,comment,
   amountMinor,changeMinor,allocations:[{expenseId,amountMinor}],reversed,reversesId,actorLabel}],
 summary:{balanceMinor,totalReceivedMinor,totalPaidMinor,totalCreditMinor,totalDueMinor}
}
```

`GET /api/branding/school` and `GET /api/branding/class` return configured PNG images to authenticated devices. Logo bytes stay in SQLite and out of `/api/state` and JSON export payloads. Issued PDFs embed the current images and remain immutable after branding changes.

Types: collection, payment, credit_apply, refund, reversal. `amountMinor` is gross received for collections, spent for payments, applied for credit, refunded for refunds. Sum of retained collections minus allocations, credit applications, and refunds = child credit. Balance includes opening + collections less change − outgoing payments − refunds; applying credit is no cash movement. Reversal records negate the target's effects once. Reject reversals that would make a child's credit negative. Expenses with opted-out children simply omit them from participants; split expenses divide exactly in integer bani with deterministic remainder distribution. Child debts are not netted against credit until explicit application. Default occurredAt to now; validate dates and request sizes. Do not silently change confirmed contributions later.

## Frontend

Native web page and ES module, no visualization wrapper. Preserve approved large surname-sorted roster and quick collection flow, rounding selected total/expense upwards to 10/50/100 without changing exact multiples; never compound rounding or reallocate earmarked excess. Money input converts decimal Romanian strings to bani. Explicit change versus credit. Single submit with server confirmation, disable duplicate clicks, keep identical requestId on network retry. No offline writes in v1; show connection state and never claim unsaved money was recorded. Refresh on online/foreground when no dirty form. PWA update `isBusy` protects dirty forms and pending saves.

Tabs: Copii, Cheltuieli, Registru, Rapoarte; settings via header. A compact header selector switches among authorized classes and resets class-local navigation state. Empty state guides school/class and adding children. Create fixed/split/quantity expenses with participant checkboxes/quantities and exact preview. Record outgoing payments with timestamp/destination/comments, optional expense. Allow use/refund of child credit and reversing posted transactions with reason. JSON export. Installable PWA manifest/icons, pwa-kit update scripts, invitation gate, no external fonts or CDNs.
