# Implementation contract

Multiple classes and schools; each class has an isolated ledger and each device has an explicit treasurer, parent or auditor permission for each authorized class. Node 24 built-in HTTP and SQLite. All money is integer bani; all UI is Romanian. Empty real database on first run (no fixtures in production). The existing prototype remains in `design/`.

## HTTP

Public server stays on `127.0.0.1:8018`. Separate admin listener `127.0.0.1:8118`; public server always returns 404 for `/api/admin` and children, even with forged admin headers. Admin listener requires constant-time `X-Admin-Token` from environment. Console's private Caddy route strips `/casierul-clasei` and proxies to 8118 with the header. Public base URL comes from environment.

Authentication and classroom endpoints:

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/health` | Public | Returns `{ok:true}`. |
| `POST /api/auth/redeem` | Public invitation | Accepts `{code,label?}`, uses one invitation activation to create a device, sets an HttpOnly, Secure, SameSite=Lax host-only cookie, and returns `{device}`. |
| `POST /api/auth/access` | Authenticated device | Accepts `{code}`, uses one invitation activation to add access to the current device without removing existing permissions, and returns `{device,classrooms,classroomId}`. Rejects a duplicate permission without using an activation. |
| `GET /api/auth/me` | Authenticated device | Returns `{device,classrooms}`; `classrooms` contains only active permissions and includes the role, child scope and access expiry for each class. |
| `POST /api/auth/logout` | Authenticated device | Revokes the whole device session and clears the cookie. |
| `GET /api/classrooms` | Authenticated device | Lists authorized classes. |
| `POST /api/classrooms` | Owner device | Accepts `{requestId,schoolName,className,schoolYear}`, creates an empty ledger, and grants its creator treasurer access. The request is idempotent. |

Device validation runs on every business request. Standard seven pwa-invite-console endpoints on the admin listener remain backward compatible. `GET /api/admin/invite-options` lists every active class and child. Invite creation accepts `role`, the selected class/child scope and `accessExpiresAt`.

New invitations allow two successful activations within seven days of creation. Both redemption endpoints share this limit and claim an activation atomically with the device or permission write. Failed requests and duplicate class permissions do not consume an activation. If the invitation or its access permission has expired, activation returns 410; exhausted or revoked codes return 404. Each activation grants the invitation's class, role, child scope and access expiry; sessions remain independent. A browser profile identifies a device through its session cookie, so a different browser or profile requires a separate activation. Revoking, deleting or logging out a device does not restore an invitation activation. Revoking an invitation prevents remaining activations without revoking devices already activated from it.

`POST /api/admin/invites` and invitation records in `GET /api/admin/invites` include additive `max_uses` and `use_count` fields. A new record has `max_uses: 2` and `use_count: 0`. After the first success, `use_count` is 1, `used_at` remains null, and `code`/`url` remain available. The second success sets `use_count` to 2 and `used_at` to the exhaustion timestamp, and clears `code`/`url`. Invitation revocation also clears the plaintext. The legacy `device_id` field points to the most recent successful activation's device and becomes null if that device is deleted. The shared console keeps partially used invitations available until exhausted; API responses and `node scripts/admin.mjs invites` expose the counters.

On migration, previously unused invitations receive the two-activation limit without changing their original expiry or revocation state. Previously consumed invitations remain exhausted at `max_uses: 1, use_count: 1`; their codes are not reopened. Revoked or expired invitations remain unusable.

The existing `ledger.sqlite` migrates as class `default`; existing treasurer devices become owners and retain access. Missing roles on legacy invitations and devices migrate to `treasurer`. The first treasurer on a fresh installation becomes the owner. Ownership allows classroom creation and is independent of the per-class role. Treasurer sessions have full access within their selected class. Auditor sessions can read that class's complete financial state and authorized PDFs, with child contact details removed. Parent sessions receive a server-projected state containing class totals, aggregate expenses and outgoing payments, plus only their associated child's details and transactions; contact details are removed here as well. Parent report access is limited to aggregate class/expense reports and that child's individual reports. Every mutation, report issuance and raw JSON export requires the treasurer role for the selected class.

Business endpoints accept `?classroom=<id>`. Omitting it selects `default` when authorized, otherwise the device's first authorized class, preserving old clients and links. The server resolves the active, unexpired permission before opening the ledger. A class UUID cannot be used to cross the permission boundary. Direct PDF, branding and JSON export URLs carry the same query parameter. Permission expiry applies per class; the device session remains usable while at least one permission is active. Device revocation and deletion apply to every permission on that device.

`GET /api/state` returns state below. `GET /api/export` downloads a JSON snapshot (business data only, no device credentials). Mutations return `{ state, transactionId? }`; errors `{error}` with appropriate HTTP status. Every business POST has `requestId` (idempotency key) and `expectedRevision`. Check idempotency before stale revision; changed payload with reused key is 409. An identical successful retry returns current state and the original transactionId without writing again. If state changed for a new request, return 409 and let user refresh/review. Financial mutations are atomic.

| Endpoint | Ledger dispatch operation | Body fields beyond requestId/expectedRevision |
| --- | --- | --- |
| POST /api/settings | settings.update | schoolName, className, schoolYear, openingBalanceMinor (opening editable only before financial transactions), schoolLogo/classLogo as resized PNG data URLs or null |
| POST /api/children | child.create | firstName, lastName |
| POST /api/children/bulk | children.create | children: [{firstName,lastName}] |
| POST /api/children/:id | child.update | firstName, lastName, active?; server adds childId from URL |
| POST /api/children/:id/contacts | child.contacts.update | contacts: [{label,phone}], zero to two entries; server adds childId and normalizes Romanian local or international numbers to E.164 |
| POST /api/expenses | expense.create | title, type: fixed/split/quantity, amountMinor (per child / total / unit), participants: [{childId,quantity?}], occurredAt?, dueDate?, comment? |
| POST /api/expenses/:id | expense.update | same fields as create; server adds expenseId. Descriptive fields remain editable. For a split expense, participants may change and their shares are recalculated while no child contribution has been allocated, even when a supplier payment or temporary advance is linked; the formula and total stay fixed. After the first allocated contribution, its participants and shares are protected. Fixed/quantity participants may still be corrected when every revised contribution covers the amount already paid and the expense total covers linked payouts. |
| POST /api/expenses/:id/cancel | expense.cancel | comment?; server adds expenseId; only allowed when no collections or linked outgoing payment remain |
| POST /api/collections | collection.create | childId, receivedMinor, changeMinor, allocations: [{expenseId,amountMinor}], settlement?: {type: credit\|rounding, allocations: [{expenseId,amountMinor}]}, occurredAt?, comment? |
| POST /api/credit/apply | credit.apply | childId, allocations: [{expenseId,amountMinor}], occurredAt?, comment? |
| POST /api/refunds | refund.create | childId, amountMinor (from existing credit), occurredAt?, comment? |
| POST /api/payments | payment.create | amountMinor, destination, expenseId?, occurredAt?, comment? |
| POST /api/fund-advances | fund_advance.create | amountMinor, person, expenseId?, occurredAt?, comment?; adds cash and records an equal class liability |
| POST /api/fund-advances/:id/repayments | fund_advance.repay | amountMinor, occurredAt?, comment?; partial or full repayment, never above the outstanding amount |
| POST /api/transactions/:id/reverse | transaction.reverse | comment (required); server adds transactionId; append correction, never erase financial history |

`POST /api/expenses/:id/attachments` and `POST /api/payments/:id/attachments` upload one raw PDF/JPG/PNG/WebP body per request. They require treasurer access, `X-Request-Id`, `X-Expected-Revision`, URI-encoded `X-Filename`, `X-Visibility: internal|class`, and the file MIME type in `Content-Type`. A file must be non-empty and at most 10 MB; each expense or payment accepts at most 25 documents, with 200 MB total attachment storage per class. The declared MIME type and file signature must agree. Uploads are idempotent and immutable. `GET /api/attachments/:id` opens the document; `?download=1` downloads it. Parents can retrieve only documents marked `class`; auditors and treasurers can retrieve both visibility levels.

`POST /api/reports` requires treasurer access and accepts `requestId`, `type: class|matrix|expense|child`, the required `subjectId` for expense/child reports, and optional `replacesId` for a corrective report. The generated PDF and its data snapshot are immutable. Contact details are removed before both are generated. `GET /api/reports/:id/pdf` returns an authorized report: auditors and treasurers may read every report, while parents may read aggregate class/expense reports and the individual report associated with their child. `GET /api/branding/school` and `GET /api/branding/class` return the configured logos to authenticated devices.

## Ledger module interface

`server/ledger.mjs` exports `class Ledger` with `constructor(dbPath)`, `getState()`, `dispatch(operation, body, actor)` -> `{state,transactionId?}`, `exportData()` -> JSON snapshot, `close()`. Actor is `{id,label}`. Errors expose `status`. `ClassroomLedgers` opens one ledger file per class; auth, the classroom catalog and permissions use a separate SQLite file.

## State

```
{
 revision: 0,
 settings: {schoolName:'',className:'',schoolYear:'',openingBalanceMinor:0,hasSchoolLogo:false,hasClassLogo:false,schoolLogoVersion:null,classLogoVersion:null},
 children: [{id,firstName,lastName,active,creditMinor,dueMinor,
   contributions:[{expenseId,title,dueDate,amountMinor,paidMinor,adjustedMinor,remainingMinor}]}],
 contacts: [{childId,position,label,phone}], // treasurer state only; omitted for auditor/parent
 expenses: [{id,title,type,amountMinor,totalMinor,collectedMinor,adjustedMinor,paidOutMinor,
   occurredAt,dueDate,comment,cancelled,
   contributions:[{childId,amountMinor,quantity}]}],
 transactions: [{id,type,occurredAt,createdAt,childId,expenseId,destination,comment,
   amountMinor,changeMinor,advanceId,allocations:[{expenseId,amountMinor}],reversed,reversesId,actorLabel}],
 advances: [{id,person,expenseId,occurredAt,createdAt,comment,amountMinor,repaidMinor,outstandingMinor,reversed}],
 attachments: [{id,entityType,entityId,filename,mimeType,size,sha256,visibility,createdAt,createdByLabel}],
 reports: [{id,serial,code,type,subjectId,subjectLabel,createdAt,stateRevision,createdByLabel,
   replacesId,replacedById,filename,sha256,size}],
 summary:{balanceMinor,netBalanceMinor,totalReceivedMinor,totalPaidMinor,totalCreditMinor,totalDueMinor,totalAdjustedMinor,
   totalAdvancedMinor,totalAdvanceRepaidMinor,totalAdvanceOutstandingMinor}
}
```

`GET /api/branding/school` and `GET /api/branding/class` return configured PNG images to authenticated devices. Logo bytes stay in SQLite and out of `/api/state` and JSON export payloads. Issued PDFs embed the current images and remain immutable after branding changes.

Types: collection, payment, credit_apply, rounding_adjustment, refund, fund_advance, advance_repayment, reversal. `amountMinor` is gross received for collections, spent for payments, applied for credit, waived for a rounding adjustment, refunded for refunds, advanced into the fund for `fund_advance`, and repaid to the lender for `advance_repayment`. Sum of retained collections minus allocations, credit applications, and refunds = child credit. Cash balance includes opening + retained collections + temporary fund advances − outgoing payments − child refunds − advance repayments; rounding adjustments never move cash. `netBalanceMinor` subtracts outstanding temporary advances from cash. Applying child credit is no cash movement. A collection settlement may atomically close exact contribution remainders totalling at most 100 bani, either from sufficient existing child credit or through a separately recorded rounding adjustment. A reversal records and negates the target's effects once. An advance with active repayments can only be reversed after those repayments are reversed. Reject operations that make child credit, contributions, or an advance balance negative. Expenses with opted-out children simply omit them from participants; split expenses divide exactly in integer bani with deterministic remainder distribution. Child debts are not netted against credit until explicit application. Default occurredAt to now; validate dates and request sizes. Do not silently change confirmed contributions later.

## Frontend

Native web page and ES module, no visualization wrapper. Preserve approved large surname-sorted roster and quick collection flow, keeping the total and rounding before individual contributions, and the WhatsApp tools after the collection form on the child screen. Round the selected total/expense upwards to 5/10/50/100 without changing exact multiples; never compound rounding or reallocate earmarked excess. Money input converts decimal Romanian strings to bani. Explicit change versus credit. For a remainder of at most 1 leu in the selected scope, offer leaving it due, covering it from sufficient existing child credit, or closing it as a non-cash rounding adjustment. Single submit with server confirmation, disable duplicate clicks, keep identical requestId on network retry. No offline writes in v1; show connection state and never claim unsaved money was recorded. Refresh on online/foreground when no dirty form. PWA update `isBusy` protects dirty forms and pending saves.

Tabs: Copii, Cheltuieli, Registru, Rapoarte; settings via header. A compact header selector switches among authorized classes and resets class-local navigation state. Empty state guides school/class and adding children. A treasurer may keep zero to two WhatsApp contacts per child; the treasurer roster shows the configured phone count or the missing-phone state on every child card. Contact status remains hidden from parent and auditor projections. The treasurer can open a direct `wa.me` conversation with the child's current unpaid contributions prefilled, and use a queue limited to active children with outstanding balances. The app only opens the conversation; it neither sends nor claims delivery. From the child screen, the treasurer can generate a child report with that child fixed as subject, then share its PDF together with the same reminder text through `navigator.share()`. The operating system still requires the user to choose WhatsApp and the conversation; unsupported browsers download the PDF. Aggregate PDF sharing uses the same operating system picker and download fallback, with prefilled Romanian text specialized for class, expense, or internal matrix reports and based only on immutable report metadata. Create fixed/split/quantity expenses with participant checkboxes/quantities and exact preview. Record outgoing payments with timestamp/destination/comments, optional expense. Record a temporary fund advance with person, optional expense, timestamp and comment; show outstanding liabilities and allow partial repayments. Attach multiple immutable supporting documents to expenses and payments, with explicit internal/class visibility. Allow use/refund of child credit and reversing posted transactions with reason. JSON export excludes child contacts. Installable PWA manifest/icons, pwa-kit update scripts, invitation gate, no external fonts or CDNs.
